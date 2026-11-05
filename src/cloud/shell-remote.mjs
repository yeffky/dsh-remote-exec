/**
 * dsh-remote-exec：远程 ctx.shell 实现（路径 B）
 *
 * 实现 DSH 的 ShellExecutor 抽象 seam（2 个方法），把 bash 命令转发到端侧 daemon。
 *
 * 为什么选 shell 而不是 subprocess：
 *   - ctx.subprocess 被 setup 探测与 session 恢复共用，替换它会波及控制面
 *   - ctx.shell 只服务 tool-bash，正是原文「只负责执行命令与返回结果」的边界
 *
 * 语义对齐 dsh-bash-local：
 *   - resolve 补默认值与上限，execute 返回 live handle + 前台投影 result()
 *   - readOutput 是消费式游标，observed 是独立偏移读取
 *   - 超时与 abort 按「首个原因」分类为 timedOut / aborted
 */
import { Methods, Events } from '../shared/protocol.mjs'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_GRACE_MS = 3_000
const COLLECT_TAIL = 2 * 1024 * 1024

/** 与 bash-local 一致的模型友好环境：关闭颜色、分页器与交互式终端特性。 */
const ENV_OVERRIDES = { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }

const clamp = (value, min, max, fallback) => {
  const n = Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(n, min), max)
}

/** 一个远程 shell 进程的云端状态。 */
class RemoteShellProcess {
  constructor(spawnId) {
    this.spawnId = spawnId
    this.status = 'running'
    this.exitCode = null
    this.signal = null
    this.startedAt = Date.now()
    /** 两个流各自累计的已接收字节，用于对齐 offset。 */
    this.offsets = { stdout: 0, stderr: 0 }
    /** 保留窗口内的数据块。 */
    this.chunks = { stdout: [], stderr: [] }
    /** readOutput 的消费游标。 */
    this.consumed = { stdout: 0, stderr: 0 }
    this.exited = false
    this.exitInfo = null
    this.exitResolve = undefined
    this.notifier = new Notifier()
    this.settle = undefined
    this.donePromise = new Promise((resolve) => { this.settle = resolve })
    this.resultPromise = undefined
    /** 前台上限：超出后 readOutput 的增量会被截断并标记 lossy。 */
    this.stdoutCap = DEFAULT_MAX_OUTPUT_BYTES
  }

  get done() { return this.donePromise }

  push(stream, buf, offset) {
    const seen = this.offsets[stream]
    if (typeof offset === 'number' && offset < seen) return   // 重复帧
    this.chunks[stream].push(buf)
    this.offsets[stream] = seen + buf.length
    // 裁剪保留窗口，保留至少一块
    let total = this.chunks[stream].reduce((n, c) => n + c.length, 0)
    while (total > COLLECT_TAIL && this.chunks[stream].length > 1) {
      total -= this.chunks[stream].shift().length
    }
    this.notifier.signal()
  }

  /** hub 的推送协议要求这个入口。 */
  notify() { this.notifier.signal() }

  /** 读取某流从 fromByte 起的增量（不消费）。 */
  sliceFrom(stream, fromByte) {
    const all = Buffer.concat(this.chunks[stream])
    const total = this.offsets[stream]
    const windowStart = total - all.length
    if (fromByte < windowStart) return { text: all.toString('utf8'), next: total, lossy: true }
    return { text: all.subarray(fromByte - windowStart).toString('utf8'), next: total, lossy: false }
  }

  /** readOutput：消费式游标，把 stdout 与 stderr 增量合并成一个 delta。 */
  readOutput() {
    const out = this.sliceFrom('stdout', this.consumed.stdout)
    const err = this.sliceFrom('stderr', this.consumed.stderr)
    this.consumed.stdout = out.next
    this.consumed.stderr = err.next
    // 前台上限：stdout 超出预算时截断并标记 lossy（与 bash-local 的 maxOutputBytes 对齐）
    let text = out.text
    let lossy = out.lossy || err.lossy
    if (text.length > this.stdoutCap) {
      text = text.slice(-this.stdoutCap)
      lossy = true
    }
    const delta = err.text ? `${text}${text ? '\n' : ''}[stderr]\n${err.text}` : text
    return { delta, lossy }
  }

  observedReader(stream) {
    let cursor = 0
    const self = this
    return {
      readFrom(fromByte) {
        const from = Number.isFinite(fromByte) ? fromByte : cursor
        const r = self.sliceFrom(stream, from)
        cursor = r.next
        return { text: r.text, nextOffset: r.next, lossy: r.lossy }
      },
    }
  }

  settleWith({ exitCode, signal }) {
    if (this.status !== 'running') return
    this.status = signal ? 'killed' : 'completed'
    this.exitCode = exitCode ?? null
    this.signal = signal ?? null
    this.exited = true
    this.exitInfo = { exitCode: this.exitCode, signal: this.signal }
    this.notifier.signal()
    this.exitResolve?.(this.exitInfo)
    this.settle()
  }

  kill() {
    if (this.status !== 'running') return false
    this.requestKill?.()
    return true
  }
}

/** 极简的变更通知器：允许多个等待者等同一批输出。 */
class Notifier {
  constructor() { this.waiters = new Set() }
  signal() {
    for (const w of this.waiters) { w() }
    this.waiters.clear()
  }
  wait(timeoutMs) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve() }
      const t = setTimeout(done, timeoutMs)
      this.waiters.add(done)
    })
  }
}

/**
 * 远程 ShellExecutor。
 *
 * 不是 Cordis Service 本身（由 plugin-shell.mjs 包装注册），便于单测。
 */
export class RemoteShellExecutor {
  constructor(hub, config = {}) {
    this.hub = hub
    this.config = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxTimeoutMs: DEFAULT_MAX_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      graceMs: DEFAULT_GRACE_MS,
      cwd: config.cwd ?? '/',
      ...config,
    }
    this.live = new Map()
  }

  /** 补默认值与上限，返回完整 spec。 */
  resolve(request) {
    const cfg = this.config
    const timeoutMs = clamp(request.timeoutMs ?? cfg.timeoutMs, 1, cfg.maxTimeoutMs, cfg.timeoutMs)
    return {
      command: request.command,
      workdir: request.workdir ?? cfg.cwd,
      timeoutMs,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: clamp(request.stdoutMaxBytes ?? cfg.maxOutputBytes, 1, cfg.maxOutputBytes, cfg.maxOutputBytes),
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /** 启动远程命令，返回 live handle + result() 投影。 */
  async execute(spec) {
    const peer = this.hub.peer()
    const spawnId = `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const proc = new RemoteShellProcess(spawnId)
    proc.stdoutCap = spec.stdoutMaxBytes
    this.live.set(spawnId, proc)
    peer.spawns.set(spawnId, proc)

    proc.requestKill = () => {
      peer.call(Methods.Terminate, { spawnId, graceMs: this.config.graceMs }, 15_000).catch(() => {})
    }

    // 超时：与 bash-local 一致，首个原因决定分类
    let timedOut = false
    let aborted = false
    const timer = spec.onExpiry === 'kill'
      ? setTimeout(() => { timedOut = true; proc.kill() }, spec.timeoutMs)
      : undefined
    const onAbort = () => { aborted = true; proc.kill() }
    if (spec.signal) {
      if (spec.signal.aborted) { aborted = true; proc.kill() }
      else spec.signal.addEventListener('abort', onAbort, { once: true })
    }

    proc.done.finally(() => {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      this.live.delete(spawnId)
      peer.spawns.delete(spawnId)
    })

    // 转发 spawn
    peer.call(Methods.ShellExec, {
      spawnId,
      command: spec.command,
      cwd: spec.workdir,
      env: { ...ENV_OVERRIDES, ...(spec.env ?? {}), ...(spec.dshEnv ?? {}) },
      graceMs: this.config.graceMs,
      stdin: spec.stdin,
    }, 120_000).catch((err) => {
      proc.push('stderr', Buffer.from(`spawn failed: ${err?.message ?? err}\n`), proc.offsets.stderr)
      proc.settleWith({ exitCode: null, signal: null })
    })

    const execution = {
      get status() { return proc.status },
      get exitCode() { return proc.exitCode },
      get signal() { return proc.signal },
      get done() { return proc.done },
      get observed() {
        return { stdout: proc.observedReader('stdout'), stderr: proc.observedReader('stderr') }
      },
      readOutput: () => proc.readOutput(),
      kill: () => proc.kill(),
      result: () => {
        proc.resultPromise ??= proc.done.then(() => {
          const stdout = proc.sliceFrom('stdout', 0)
          const stderr = proc.sliceFrom('stderr', 0)
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            timedOut,
            aborted: aborted && !timedOut,
            timeoutMs: spec.timeoutMs,
            stdout: { text: stdout.text, truncated: stdout.lossy || stdout.text.length > spec.stdoutMaxBytes },
            stderr: { text: stderr.text, truncated: stderr.lossy },
          }
        })
        return proc.resultPromise
      },
    }

    if (spec.stdin !== undefined) {
      peer.call(Methods.ShellStdin, { spawnId, data: spec.stdin }, 30_000).catch(() => {})
    }

    return execution
  }

  /** teardown：终止所有仍在运行的远程进程。 */
  dispose() {
    for (const [, proc] of this.live) { try { proc.kill() } catch { /* 已退出 */ } }
    this.live.clear()
  }
}