#!/usr/bin/env node
/**
 * dsh-remote-exec 端侧 daemon
 *
 * 职责（原文 5.2：「轻量 daemon，只负责执行命令与返回结果」）：
 *   - 处理 shellExec：以 bash 解释命令，流式回传输出
 *   - 处理 terminate：终止进程
 *
 * 它**不调模型、不存会话、不做决策**。
 *
 * 用法：
 *   node daemon.mjs --endpoint ws://127.0.0.1:7777 --token <secret>
 *                   --work-root /path/to/work
 */
import { spawn } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { parse, Methods, Events, event, result, failure } from '../shared/protocol.mjs'

const require = createRequire(import.meta.url)
let WebSocket
try { WebSocket = require('ws') } catch {
  console.error('缺少依赖 ws，请先运行: npm install ws')
  process.exit(1)
}

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i > -1 ? args[i + 1] : fallback
}

const ENDPOINT = argOf('endpoint', process.env.REMOTE_ENDPOINT ?? 'ws://127.0.0.1:7777')
const TOKEN = argOf('token', process.env.DAEMON_TOKEN ?? '')
const GRACE_MS = Number(argOf('grace', process.env.GRACE_MS ?? '3000'))

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[daemon]', ...a)

/** 远程 shell 允许的工作根目录；由 --work-root 或 WORK_ROOT 指定。 */
function workRoot() {
  const i = args.indexOf('--work-root')
  return (i > -1 ? args[i + 1] : undefined) ?? process.env.WORK_ROOT ?? '/tmp'
}

/** 活跃的 spawn 句柄：spawnId → { child, exited, exitInfo } */
const live = new Map()

let ws
let nextId = 1
let reconnectDelay = 1000

function send(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg))
}

function reply(id, value) { send(result(id, value)) }
function fail(id, err) { send(failure(id, err?.message ?? err)) }
function emit(method, params) { send(event(method, params)) }

/** 去掉凭据形状的环境变量，与 DSH 的 scrubbedParentEnv 语义一致。 */
function scrubbedEnv() {
  const out = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/key|password|secret|token/i.test(k) && !k.startsWith('LARK')) continue
    out[k] = v
  }
  return out
}


/**
 * 路径 B：shell seam 的执行入口。
 * 语义与 bash-local 一致——命令交给 bash -lc 解释，stdout/stderr 作为事件流回传。
 */
function handleShellExec(id, params) {
  const { spawnId, command, cwd, env, graceMs, stdin } = params
  if (typeof command !== 'string' || !command) return fail(id, 'command is required')
  if (live.has(spawnId)) return fail(id, `spawnId ${spawnId} already active`)

  // 边界：远程 shell 向云端声明了 workspace-write，这里必须真正限制 cwd。
  const target = resolve(cwd || workRoot())
  const root = resolve(workRoot())
  if (target !== root && !target.startsWith(root + sep)) {
    return fail(id, `cwd 超出允许范围: ${target} 不在 ${root} 下`)
  }

  const child = spawn('bash', ['-lc', command], {
    cwd: target,
    env: { ...scrubbedEnv(), ...(env ?? {}) },
    stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })

  const entry = { child, exited: false, exitInfo: null, startedAt: Date.now(), graceMs: graceMs ?? GRACE_MS }
  live.set(spawnId, entry)

  if (stdin !== undefined && child.stdin) {
    child.stdin.end(String(stdin))
  }

  let outOffset = 0
  let errOffset = 0
  child.stdout.on('data', (buf) => {
    emit(Events.Output, { spawnId, stream: 'stdout', offset: outOffset, data: buf.toString('base64') })
    outOffset += buf.length
  })
  child.stderr.on('data', (buf) => {
    emit(Events.Output, { spawnId, stream: 'stderr', offset: errOffset, data: buf.toString('base64') })
    errOffset += buf.length
  })

  child.on('spawn', () => {
    emit(Events.Spawned, { spawnId, pid: child.pid })
    reply(id, { spawnId, pid: child.pid })
  })
  child.on('error', (err) => {
    entry.exited = true
    entry.exitInfo = { exitCode: null, signal: null, error: String(err?.message ?? err) }
    emit(Events.Exit, { spawnId, ...entry.exitInfo })
    if (!entry.replied) { entry.replied = true; fail(id, err) }
  })
  child.on('close', (code, signal) => {
    entry.exited = true
    entry.exitInfo = { exitCode: code, signal }
    emit(Events.Exit, { spawnId, exitCode: code, signal })
  })
}

function handleTerminate(id, params) {
  const entry = live.get(params.spawnId)
  if (!entry) return reply(id, { terminated: false, reason: 'unknown' })
  if (entry.exited) return reply(id, { terminated: false, reason: 'already-exited' })
  try { entry.child.kill('SIGTERM') } catch { /* 已退出 */ }
  const timer = setTimeout(() => {
    try { entry.child.kill('SIGKILL') } catch { /* 已退出 */ }
  }, params.graceMs ?? GRACE_MS)
  entry.child.once('close', () => clearTimeout(timer))
  reply(id, { terminated: true })
}

async function handleWait(id, params) {
  const entry = live.get(params.spawnId)
  if (!entry) return reply(id, { settled: true, reason: 'unknown' })
  if (entry.exited) return reply(id, { settled: true, ...entry.exitInfo })
  await new Promise((done) => entry.child.once('close', done))
  reply(id, { settled: true, ...entry.exitInfo })
}

function route(msg) {
  const { id, method, params } = msg
  if (!method) return
  try {
    switch (method) {
      case Methods.ShellExec:
        return handleShellExec(id, params)
      case Methods.Terminate:
        return handleTerminate(id, params)
      default:
        return fail(id, `unknown method ${method}`)
    }
  } catch (e) { fail(id, e) }
}

function connect() {
  ws = new WebSocket(ENDPOINT, {
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
  })

  ws.on('open', () => {
    reconnectDelay = 1000
    log(`已连接 ${ENDPOINT}`)
    emit(Events.Ready, {
      hostname: process.env.HOSTNAME ?? 'unknown',
      platform: process.platform,
      cwd: process.cwd(),
      pid: process.pid,
    })
  })

  ws.on('message', (raw) => {
    const msg = parse(raw)
    if (msg) route(msg)
  })

  ws.on('close', () => {
    log('连接断开，正在重连…')
    // 断线时清理本地进程，避免泄漏
    for (const [, entry] of live) {
      try { entry.child.kill('SIGTERM') } catch { /* ignore */ }
    }
    live.clear()
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
  })

  ws.on('error', (err) => log('连接错误:', String(err?.message ?? err).slice(0, 150)))
}

log(`端侧 daemon 启动 | endpoint=${ENDPOINT}`)
connect()

process.on('SIGINT', () => {
  log('收到 SIGINT，清理进程')
  for (const [, entry] of live) { try { entry.child.kill('SIGTERM') } catch { /* ignore */ } }
  ws?.close()
  process.exit(0)
})