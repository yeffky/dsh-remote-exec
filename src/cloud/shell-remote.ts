/**
 * dsh-remote-exec：远程 ctx.shell 实现
 *
 * 实现 DSH 的 ShellExecutor 抽象 seam（`resolve` 与 `execute`），把 bash 命令
 * 转发到端侧 daemon 执行。
 *
 * 为什么替换 shell 而不是 subprocess：`ctx.subprocess` 被 setup 探测与会话恢复
 * 共用，替换它会让控制面也跑到执行主机上；`ctx.shell` 只服务 `tool-bash`，
 * 正是「只负责执行命令与返回结果」的准确边界。原型的实测差异见
 * `docs/001-architecture.md`。
 *
 * 语义对齐 `dsh-bash-local`：
 * - `resolve` 补默认值与上限；
 * - `execute` 返回 live handle，前台投影由 `result()` 给出；
 * - `readOutput` 是消费式游标，`observed` 是独立偏移读取；
 * - 超时与 abort 按首个原因分类为 `timedOut` / `aborted`。
 */
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { SubprocessOutputRead } from '@deepseek-ai/dsh-subprocess'
import { Methods } from '../shared/protocol.ts'
import type { ExitInfo, Peer, RemoteHub, SpawnState } from './hub.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_GRACE_MS = 3_000
/** 每个流在云端保留的窗口，超过后旧块被丢弃并标记 lossy。 */
const COLLECT_TAIL = 2 * 1024 * 1024

/** 与 bash-local 一致的模型友好环境：关闭颜色、分页器与交互式终端特性。 */
const ENV_OVERRIDES: Readonly<Record<string, string>> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

const clamp = (value: number | undefined, min: number, max: number, fallback: number): number => {
  const n = value !== undefined && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(n, min), max)
}

type Stream = 'stdout' | 'stderr'

/** 每个流的缓冲区。`offsets` 是已接收总字节，`chunks` 只保留尾部窗口。 */
interface StreamBuffers {
  offsets: Record<Stream, number>
  chunks: Record<Stream, Buffer[]>
  consumed: Record<Stream, number>
}

/** 极简变更通知器：允许任意数量的等待者等同一批输出。 */
class Notifier {
  private readonly waiters = new Set<() => void>()

  signal(): void {
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }
}

/** 一个远程 shell 进程在云端的状态。实现 hub 的 `SpawnState` 契约。 */
class RemoteShellProcess implements SpawnState {
  readonly spawnId: string
  status: ShellProcessStatus = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  /** 前台输出上限，超出后 `readOutput` 截断并标记 lossy。 */
  stdoutCap = DEFAULT_MAX_OUTPUT_BYTES
  /** 由 executor 注入：向 daemon 发 terminate。 */
  requestKill?: () => void

  private readonly buffers: StreamBuffers = {
    offsets: { stdout: 0, stderr: 0 },
    chunks: { stdout: [], stderr: [] },
    consumed: { stdout: 0, stderr: 0 },
  }
  private readonly notifier = new Notifier()
  private readonly settled: Promise<void>
  private settleResolve!: () => void
  private resultMemo?: Promise<ShellRunResult>

  constructor(spawnId: string) {
    this.spawnId = spawnId
    this.settled = new Promise<void>((resolve) => { this.settleResolve = resolve })
  }

  get done(): Promise<void> {
    return this.settled
  }

  /** hub 收到 output 事件时调用。重复帧（offset 回退）直接丢弃。 */
  push(stream: Stream, chunk: Buffer, offset: number): void {
    const seen = this.buffers.offsets[stream]
    if (offset < seen) return
    this.buffers.chunks[stream].push(chunk)
    this.buffers.offsets[stream] = seen + chunk.length
    let total = this.buffers.chunks[stream].reduce((n, c) => n + c.length, 0)
    const chunks = this.buffers.chunks[stream]
    while (total > COLLECT_TAIL && chunks.length > 1) {
      total -= chunks.shift()!.length
    }
  }

  /** hub 收到其他事件时调用；这里只是唤醒等待输出的读者。 */
  notify(): void {
    this.notifier.signal()
  }

  /** 读取某流自 `fromByte` 起的增量，不改变消费游标。 */
  private sliceFrom(stream: Stream, fromByte: number): { text: string; next: number; lossy: boolean } {
    const chunks = this.buffers.chunks[stream]
    const all = Buffer.concat(chunks)
    const total = this.buffers.offsets[stream]
    const windowStart = total - all.length
    if (fromByte < windowStart) {
      return { text: all.toString('utf8'), next: total, lossy: true }
    }
    return { text: all.subarray(fromByte - windowStart).toString('utf8'), next: total, lossy: false }
  }

  /** 消费式读取：把标准输出与标准错误的增量合并成一个 delta。 */
  readOutput(): ShellProcessRead {
    const out = this.sliceFrom('stdout', this.buffers.consumed.stdout)
    const err = this.sliceFrom('stderr', this.buffers.consumed.stderr)
    this.buffers.consumed.stdout = out.next
    this.buffers.consumed.stderr = err.next
    let text = out.text
    let lossy = out.lossy || err.lossy
    if (text.length > this.stdoutCap) {
      text = text.slice(-this.stdoutCap)
      lossy = true
    }
    const delta = err.text === '' ? text : `${text}${text === '' ? '' : '\n'}[stderr]\n${err.text}`
    return { delta, lossy }
  }

  /** 非消费式读取器，供 `observed` 使用。 */
  observedReader(stream: Stream): { readFrom(fromByte: number): SubprocessOutputRead } {
    return {
      readFrom: (fromByte: number): SubprocessOutputRead => {
        const r = this.sliceFrom(stream, fromByte)
        return { text: r.text, nextOffset: r.next, lossy: r.lossy }
      },
    }
  }

  /** hub 收到 exit 事件时调用；只落定一次。 */
  settleWith(info: ExitInfo): void {
    if (this.status !== 'running') return
    this.status = info.signal === null ? 'completed' : 'killed'
    this.exitCode = info.exitCode
    this.signal = info.signal === null ? null : (info.signal as NodeJS.Signals)
    if (info.error !== undefined) {
      this.push('stderr', Buffer.from(`${info.error}\n`), this.buffers.offsets.stderr)
    }
    this.notifier.signal()
    this.settleResolve()
  }

  kill(): boolean {
    if (this.status !== 'running') return false
    this.requestKill?.()
    return true
  }

  /**
   * 前台投影，按需创建并记忆化。
   *
   * `classify` 在 settled 之后才被调用，因此读到的是执行结束时的首因标志；
   * 若提前取值，`result()` 在命令结束前被调用就会拿到未更新的快照。
   */
  result(classify: () => { timedOut: boolean; aborted: boolean }, spec: ShellExecSpec): Promise<ShellRunResult> {
    this.resultMemo ??= this.settled.then(() => {
      const { timedOut, aborted } = classify()
      const stdout = this.sliceFrom('stdout', 0)
      const stderr = this.sliceFrom('stderr', 0)
      return {
        exitCode: this.exitCode,
        signal: this.signal,
        timedOut,
        aborted: aborted && !timedOut,
        timeoutMs: spec.timeoutMs,
        stdout: {
          text: stdout.text,
          truncated: stdout.lossy || stdout.text.length > spec.stdoutMaxBytes,
        },
        stderr: { text: stderr.text, truncated: stderr.lossy },
      }
    })
    return this.resultMemo
  }
}

export interface RemoteShellExecutorConfig {
  cwd?: string
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  graceMs?: number
}

/**
 * 远程 ShellExecutor。
 *
 * 不是 Cordis Service 本身——由 `plugin-shell.ts` 包装注册，这样单测可以直接
 * 构造它而不依赖宿主。
 */
export class RemoteShellExecutor {
  private readonly hub: RemoteHub
  private readonly config: Required<RemoteShellExecutorConfig>
  private readonly live = new Map<string, RemoteShellProcess>()

  constructor(hub: RemoteHub, config: RemoteShellExecutorConfig = {}) {
    this.hub = hub
    this.config = {
      cwd: config.cwd ?? '/',
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxTimeoutMs: config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
      maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    }
  }

  /** 补默认值与上限，返回完整 spec。 */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const cfg = this.config
    return {
      command: request.command,
      workdir: request.workdir ?? cfg.cwd,
      timeoutMs: clamp(request.timeoutMs, 1, cfg.maxTimeoutMs, cfg.timeoutMs),
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: clamp(request.stdoutMaxBytes, 1, cfg.maxOutputBytes, cfg.maxOutputBytes),
      ...request.signal === undefined ? {} : { signal: request.signal },
      ...request.stdin === undefined ? {} : { stdin: request.stdin },
      ...request.env === undefined ? {} : { env: request.env },
      ...request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv },
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /** 启动远程命令，返回 live handle。 */
  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const peer: Peer = this.hub.peer()
    const spawnId = `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const proc = new RemoteShellProcess(spawnId)
    proc.stdoutCap = spec.stdoutMaxBytes
    this.live.set(spawnId, proc)
    peer.spawns.set(spawnId, proc)

    proc.requestKill = (): void => {
      peer.call(Methods.Terminate, { spawnId, graceMs: this.config.graceMs }, 15_000)
        .catch(() => { /* 进程可能已退出 */ })
    }

    // 首个原因决定分类：定时器先触发就是 timedOut，abort 先触发就是 aborted。
    let timedOut = false
    let aborted = false
    const timer = spec.onExpiry === 'kill'
      ? setTimeout(() => { timedOut = true; proc.kill() }, spec.timeoutMs)
      : undefined
    const onAbort = (): void => { aborted = true; proc.kill() }
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) onAbort()
      else spec.signal.addEventListener('abort', onAbort, { once: true })
    }

    void proc.done.finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      this.live.delete(spawnId)
      peer.spawns.delete(spawnId)
    })

    peer.call(Methods.ShellExec, {
      spawnId,
      command: spec.command,
      cwd: spec.workdir,
      env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },
      graceMs: this.config.graceMs,
      ...spec.stdin === undefined ? {} : { stdin: spec.stdin },
    }, 120_000).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      proc.push('stderr', Buffer.from(`spawn failed: ${message}\n`), Number.MAX_SAFE_INTEGER)
      proc.settleWith({ exitCode: null, signal: null })
    })

    const execution: ShellExecution = {
      get status(): ShellProcessStatus { return proc.status },
      get exitCode(): number | null { return proc.exitCode },
      get signal(): NodeJS.Signals | null { return proc.signal },
      get done(): Promise<void> { return proc.done },
      get observed() {
        return { stdout: proc.observedReader('stdout'), stderr: proc.observedReader('stderr') }
      },
      readOutput: (): ShellProcessRead => proc.readOutput(),
      kill: (): boolean => proc.kill(),
      result: (): Promise<ShellRunResult> => proc.result(() => ({ timedOut, aborted }), spec),
    }

    return execution
  }

  /** teardown：终止所有仍在运行的远程进程。 */
  dispose(): void {
    for (const [, proc] of this.live) {
      try { proc.kill() } catch { /* 已退出 */ }
    }
    this.live.clear()
  }
}