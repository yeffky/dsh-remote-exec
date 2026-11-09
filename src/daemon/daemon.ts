#!/usr/bin/env node
/**
 * dsh-remote-exec 端侧 daemon
 *
 * 职责（原文 5.2：「轻量 daemon，只负责执行命令与返回结果」）：
 * - 处理 `shellExec`：以 `bash -lc` 解释命令，流式回传输出
 * - 处理 `terminate`：先 SIGTERM，宽限期后 SIGKILL
 *
 * 它**不调模型、不存会话、不做决策**；重启后不恢复任何状态，只重新连接。
 *
 * 用法：
 *   node daemon.js --endpoint ws://host:7777 --token <secret> --work-root /path/to/work
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { Methods, Events, event, result, failure, parse } from '../shared/protocol.ts'
import type { ShellExecParams, TerminateParams } from '../shared/protocol.ts'

/** 默认 SIGTERM 到 SIGKILL 的宽限期。 */
const DEFAULT_GRACE_MS = 3_000
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** 命令输出的单块上限，避免一次写入过大帧。 */
const CHUNK_LIMIT = 64 * 1024
const execFileAsync = promisify(execFile)
const PREPARE_ENV_KEYS = [
  'DSH_SUPERAGENT_GITHUB_REPOSITORY',
  'DSH_SUPERAGENT_GITHUB_NUMBER',
  'DSH_SUPERAGENT_GITHUB_PR_HEAD',
  'DSH_SUPERAGENT_NAME',
  'DSH_SUPERAGENT_TICKET',
] as const

interface LiveProcess {
  child: ChildProcess
  graceMs: number
  exited: boolean
  exitInfo: { exitCode: number | null; signal: string | null; error?: string } | null
}

const args = process.argv.slice(2)
const argOf = (name: string, fallback: string | undefined): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i > -1 ? args[i + 1] : fallback
}

const ENDPOINT = argOf('endpoint', process.env.REMOTE_ENDPOINT) ?? 'ws://127.0.0.1:7777'
const TOKEN = argOf('token', process.env.DAEMON_TOKEN) ?? ''
const DEFAULT_GRACE = Number(argOf('grace', process.env.GRACE_MS) ?? DEFAULT_GRACE_MS)

/** 执行允许的工作根；`dir` 相对它解析，越界的标识被拒绝。 */
function workRoot(): string {
  return argOf('work-root', process.env.WORK_ROOT) ?? '/tmp'
}

/**
 * 目录不存在时要跑的准备命令，`$DIR` 会被替换成目标目录。
 *
 * 典型值是建一个 git worktree。留空表示不准备，直接在新目录里执行——对
 * 与环境无关的命令（如 hostname）够用，需要源码的命令则必须配它。
 */
function prepareCommand(): string {
  return argOf('prepare', process.env.PREPARE_COMMAND) ?? ''
}

const log = (...a: unknown[]): void => {
  console.log(new Date().toISOString().slice(11, 19), '[daemon]', ...a)
}

/** 活跃进程，按 spawnId 索引。连接断开时全部清理。 */
const live = new Map<string, LiveProcess>()
const workspacePreparation = new Map<string, Promise<void>>()
const preparingSpawns = new Set<string>()
const cancelledSpawns = new Set<string>()
const disconnectedSpawns = new Set<string>()

let ws: WebSocket | undefined
let reconnectDelay = 1_000

function send(msg: unknown): void {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg))
}

function reply(id: number, value?: unknown): void { send(result(id, value)) }
function fail(id: number, error: unknown): void {
  send(failure(id, error instanceof Error ? error.message : error))
}
function emit<T>(method: string, params: T): void { send(event(method, params)) }

/**
 * 移除凭据形状的环境变量，与 DSH 的 scrubbedParentEnv 语义一致。
 *
 * `LARK*` 例外：飞书 CLI 的配置目录变量不含凭据本身，却被这条正则命中，
 * 排除它以免端侧无法启动 lark-cli。
 */
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/key|password|secret|token/i.test(key) && !key.startsWith('LARK')) continue
    out[key] = value
  }
  return out
}

/** 以分块方式推送，避免单帧过大；`offset` 是整流的字节偏移。 */
function pipeOutput(spawnId: string, stream: 'stdout' | 'stderr', source: NodeJS.ReadableStream): void {
  let offset = 0
  source.on('data', (chunk: Buffer) => {
    for (let start = 0; start < chunk.length; start += CHUNK_LIMIT) {
      const slice = chunk.subarray(start, Math.min(start + CHUNK_LIMIT, chunk.length))
      emit(Events.Output, { spawnId, stream, offset, data: slice.toString('base64') })
      offset += slice.length
    }
  })
}

/** 执行一条 shell 命令。命令交给 `bash -lc` 解释，与 bash-local 一致。 */
/**
 * 执行一条 shell 命令。
 *
 * `dir` 来自云端，是**相对标识**而非绝对路径：执行主机自己决定目录根。拼接后
 * 若目录还不存在，先用 `--prepare` 给的命令准备它（通常是建 git worktree），
 * 再执行用户的命令。准备命令失败时整个请求失败，不会在空目录里继续跑。
 */
function handleShellExec(id: number, params: ShellExecParams): void {
  const { spawnId, command, dir, env, graceMs, stdin, workspace } = params
  if (typeof command !== 'string' || command === '') return fail(id, 'command is required')
  if (live.has(spawnId)) return fail(id, `spawnId ${spawnId} already active`)

  let target: string
  try {
    if (workspace !== undefined) {
      validateWorkspace(workspace)
      if (dir !== workspace.ticket) throw new Error('Ticket workspace directory does not match its ticket identifier')
      target = resolveDir(workspace.ticket)
    } else {
      target = resolveDir(dir)
    }
  } catch (error) { return fail(id, error) }

  preparingSpawns.add(spawnId)
  void runWithPrepare(id, spawnId, target, command, env, graceMs, stdin, workspace)
    .finally(() => {
      preparingSpawns.delete(spawnId)
      cancelledSpawns.delete(spawnId)
      disconnectedSpawns.delete(spawnId)
    })
}

function validateWorkspace(workspace: NonNullable<ShellExecParams['workspace']>): void {
  const repositoryParts = workspace.repository.split('/')
  if (repositoryParts.length !== 2 || repositoryParts.some(part =>
    !/^[A-Za-z0-9_.-]{1,100}$/.test(part) || part === '.' || part === '..')) {
    throw new Error(`invalid GitHub repository identifier: ${workspace.repository}`)
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspace.ticket)) {
    throw new Error(`invalid Superagent ticket identifier: ${workspace.ticket}`)
  }
  for (const [label, value] of [['name', workspace.name], ['number', workspace.number], ['pull request ref', workspace.prHead]] as const) {
    if (value !== undefined && (value.length > 256 || value.includes('\0'))) {
      throw new Error(`invalid ${label} in workspace context`)
    }
  }
}

/** 把云端给的相对标识拼到本机的 work-root 上，拒绝越界的标识。 */
function resolveDir(dir: string): string {
  const root = resolve(workRoot())
  if (dir === '' || dir === '.') return root
  const target = resolve(root, dir)
  if (!isWithin(root, target)) {
    throw new Error(`dir 超出工作根: ${dir} 解析为 ${target}，不在 ${root} 下`)
  }
  return target
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** 目录不存在时先跑准备命令，再执行用户命令；准备失败则整个请求失败。 */
async function runWithPrepare(id: number, spawnId: string, target: string, command: string,
  env: Record<string, string> | undefined, graceMs: number | undefined, stdin: string | undefined,
  workspace?: ShellExecParams['workspace']): Promise<void> {
  if (workspace !== undefined) {
    try { await ensureWorkspaceReady(target, env, workspace) }
    catch (error) {
      if (disconnectedSpawns.has(spawnId)) return
      return fail(id, error)
    }
    if (cancelledSpawns.has(spawnId)) {
      if (!disconnectedSpawns.has(spawnId)) fail(id, 'execution cancelled during workspace preparation')
      return
    }
    startCommand(id, spawnId, target, command, env, graceMs, stdin, workspace)
    return
  }

  try { await ensureWithinWorkRoot(target) }
  catch (error) {
    if (disconnectedSpawns.has(spawnId)) return
    return fail(id, error)
  }

  if (cancelledSpawns.has(spawnId)) {
    if (!disconnectedSpawns.has(spawnId)) fail(id, 'execution cancelled during directory preparation')
    return
  }

  if (!existsSync(target)) {
    const prepare = prepareCommand()
    if (prepare === '') {
      // 没有准备命令时建空目录：与环境无关的命令（如 hostname）仍可执行。
      try { await mkdir(target, { recursive: true }) }
      catch (error) {
        if (disconnectedSpawns.has(spawnId)) return
        return fail(id, `创建目录失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      try { await runPrepare(prepare, target, env, workspace) }
      catch (error) {
        if (disconnectedSpawns.has(spawnId)) return
        return fail(id, `准备目录失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (cancelledSpawns.has(spawnId)) {
    if (!disconnectedSpawns.has(spawnId)) fail(id, 'execution cancelled during directory preparation')
    return
  }
  startCommand(id, spawnId, target, command, env, graceMs, stdin)
}

async function ensureWorkspaceReady(target: string, env: Record<string, string> | undefined,
  workspace: NonNullable<ShellExecParams['workspace']>): Promise<void> {
  let preparation = workspacePreparation.get(target)
  if (preparation === undefined) {
    preparation = Promise.resolve().then(async () => {
      await ensureWithinWorkRoot(target)
      let createdByPrepare = false
      if (!existsSync(target)) {
        const prepare = prepareCommand()
        if (prepare === '') throw new Error(`remote workspace ${workspace.repository} requires a daemon --prepare command`)
        try {
          await runPrepare(prepare, target, env, workspace)
          createdByPrepare = true
        } catch (error) {
          await rm(target, { recursive: true, force: true }).catch(() => {})
          throw error
        }
      }
      try {
        await ensureWithinWorkRoot(target)
        await verifyWorkspace(target, workspace.repository)
      } catch (error) {
        if (createdByPrepare) await rm(target, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    })
    workspacePreparation.set(target, preparation)
  }
  try { await preparation }
  finally {
    if (workspacePreparation.get(target) === preparation) workspacePreparation.delete(target)
  }
}

async function ensureWithinWorkRoot(target: string): Promise<void> {
  const root = resolve(workRoot())
  await mkdir(root, { recursive: true })
  const canonicalRoot = await realpath(root)
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Ticket workspace cannot be a symlink')
    const canonicalTarget = await realpath(target)
    if (!isWithin(canonicalRoot, canonicalTarget)) {
      throw new Error('Ticket workspace escapes work-root')
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    let ancestor = dirname(target)
    while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor)
    const canonicalAncestor = await realpath(ancestor)
    if (!isWithin(canonicalRoot, canonicalAncestor)) {
      throw new Error('Ticket workspace escapes work-root')
    }
  }
}

function prepareEnvironment(env: Record<string, string> | undefined,
  workspace: ShellExecParams['workspace'], target: string): Record<string, string> {
  const result = scrubbedEnv()
  for (const key of PREPARE_ENV_KEYS) delete result[key]
  delete result.DSH_SUPERAGENT_DIR
  delete result.SSH_AUTH_SOCK
  delete result.SSH_AGENT_PID
  if (workspace === undefined) return result
  const values: Record<string, string | undefined> = {
    DSH_SUPERAGENT_GITHUB_REPOSITORY: workspace.repository,
    DSH_SUPERAGENT_GITHUB_NUMBER: workspace.number,
    DSH_SUPERAGENT_GITHUB_PR_HEAD: workspace.prHead,
    DSH_SUPERAGENT_NAME: workspace.name,
    DSH_SUPERAGENT_TICKET: workspace.ticket,
  }
  for (const key of PREPARE_ENV_KEYS) {
    const value = values[key] ?? env?.[key]
    if (value !== undefined) result[key] = value
  }
  result.DSH_SUPERAGENT_DIR = target
  return result
}

async function verifyWorkspace(target: string, repository: string): Promise<void> {
  let origin: string
  try {
    const output = await execFileAsync('git', ['-C', target, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      env: scrubbedEnv(),
    })
    origin = output.stdout.trim()
  } catch (error) {
    throw new Error(`prepared workspace is not a Git checkout: ${error instanceof Error ? error.message : String(error)}`)
  }
  const actualRepository = repositoryFromOrigin(origin)
  if (actualRepository !== repository.toLowerCase()) {
    throw new Error(`prepared workspace origin mismatch: expected ${repository}, got ${actualRepository ?? 'an unrecognized GitHub origin'}`)
  }
}

function repositoryFromOrigin(origin: string): string | undefined {
  const match = origin.match(/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/i)
  return match?.[1].toLowerCase()
}

/** 在 daemon 本机跑一次准备命令；`$DIR` 是远程 Ticket 目录。 */
async function runPrepare(template: string, target: string, env: Record<string, string> | undefined,
  workspace?: ShellExecParams['workspace']): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const command = template.replaceAll('$DIR', target)
  await new Promise<void>((done, reject) => {
    const child = spawn('bash', workspace === undefined ? ['-lc', command] : ['--noprofile', '--norc', '-c', command], {
      cwd: dirname(target),
      env: prepareEnvironment(env, workspace, target),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    let timedOut = false
    let forceKillTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* 子进程可能已退出 */ }
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 子进程可能已退出 */ }
      }, DEFAULT_GRACE_MS)
    }, PREPARE_TIMEOUT_MS)
    const clearTimers = (): void => {
      clearTimeout(timeout)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
    }
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    child.on('error', (error: Error) => {
      clearTimers()
      reject(new Error(`${error.message}\n${err}`.trim()))
    })
    child.on('close', (code) => {
      clearTimers()
      if (timedOut) return reject(new Error(`prepare timed out after ${PREPARE_TIMEOUT_MS}ms\n${err}`.trim()))
      if (code === 0) done()
      else reject(new Error(err.trim() || `prepare exited with ${code}`))
    })
  })
}

function startCommand(id: number, spawnId: string, target: string, command: string,
  env: Record<string, string> | undefined, graceMs: number | undefined, stdin: string | undefined,
  workspace?: ShellExecParams['workspace']): void {
  const commandEnv = { ...scrubbedEnv(), ...(env ?? {}) }
  if (workspace !== undefined) {
    commandEnv.DSH_SUPERAGENT_DIR = target
    commandEnv.DSH_SUPERAGENT_GITHUB_REPOSITORY = workspace.repository
    commandEnv.DSH_SUPERAGENT_TICKET = workspace.ticket
    if (workspace.name !== undefined) commandEnv.DSH_SUPERAGENT_NAME = workspace.name
    if (workspace.number !== undefined) commandEnv.DSH_SUPERAGENT_GITHUB_NUMBER = workspace.number
    if (workspace.prHead !== undefined) commandEnv.DSH_SUPERAGENT_GITHUB_PR_HEAD = workspace.prHead
  }
  const child = spawn('bash', ['-lc', command], {
    cwd: target,
    env: commandEnv,
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })

  const entry: LiveProcess = {
    child,
    graceMs: graceMs ?? DEFAULT_GRACE,
    exited: false,
    exitInfo: null,
  }
  live.set(spawnId, entry)

  if (stdin !== undefined && child.stdin !== null) child.stdin.end(String(stdin))
  if (child.stdout !== null) pipeOutput(spawnId, 'stdout', child.stdout)
  if (child.stderr !== null) pipeOutput(spawnId, 'stderr', child.stderr)

  child.on('spawn', () => {
    emit(Events.Spawned, { spawnId, pid: child.pid })
    reply(id, { spawnId, pid: child.pid })
  })
  child.on('error', (error: Error) => {
    entry.exited = true
    entry.exitInfo = { exitCode: null, signal: null, error: error.message }
    emit(Events.Exit, { spawnId, ...entry.exitInfo })
    fail(id, error)
  })
  child.on('close', (code, signal) => {
    entry.exited = true
    entry.exitInfo = { exitCode: code, signal: signal ?? null }
    emit(Events.Exit, { spawnId, exitCode: code, signal: signal ?? null })
  })
}

/** 终止进程：先 SIGTERM，宽限期后升级为 SIGKILL。 */
function handleTerminate(id: number, params: TerminateParams): void {
  const entry = live.get(params.spawnId)
  if (entry === undefined) {
    if (preparingSpawns.has(params.spawnId)) {
      cancelledSpawns.add(params.spawnId)
      return reply(id, { terminated: true, reason: 'cancelled-before-spawn' })
    }
    return reply(id, { terminated: false, reason: 'unknown' })
  }
  if (entry.exited) return reply(id, { terminated: false, reason: 'already-exited' })

  const grace = params.graceMs ?? entry.graceMs
  try { entry.child.kill('SIGTERM') } catch { /* 已退出 */ }
  const timer = setTimeout(() => {
    try { entry.child.kill('SIGKILL') } catch { /* 已退出 */ }
  }, grace)
  entry.child.once('close', () => { clearTimeout(timer) })
  reply(id, { terminated: true })
}

function route(msg: Record<string, unknown>): void {
  const id = typeof msg.id === 'number' ? msg.id : undefined
  const method = msg.method
  if (id === undefined || typeof method !== 'string') return
  const params = (msg.params ?? {}) as Record<string, unknown>
  try {
    switch (method) {
      case Methods.ShellExec:
        return handleShellExec(id, params as unknown as ShellExecParams)
      case Methods.WorkspaceExec: {
        const workspace = (params as unknown as ShellExecParams).workspace
        if (workspace === undefined) return fail(id, 'workspace context is required')
        return handleShellExec(id, params as unknown as ShellExecParams)
      }
      case Methods.Terminate:
        return handleTerminate(id, params as unknown as TerminateParams)
      default:
        return fail(id, `unknown method ${method}`)
    }
  } catch (error) { fail(id, error) }
}

/** 清理全部在跑进程。断连与退出时调用，避免遗留孤儿进程。 */
function cleanup(): void {
  for (const spawnId of preparingSpawns) {
    cancelledSpawns.add(spawnId)
    disconnectedSpawns.add(spawnId)
  }
  for (const [, entry] of live) {
    try { entry.child.kill('SIGTERM') } catch { /* 已退出 */ }
  }
  live.clear()
}

function connect(): void {
  const socket = new WebSocket(ENDPOINT, {
    headers: TOKEN === '' ? {} : { authorization: `Bearer ${TOKEN}` },
  })
  ws = socket

  socket.on('open', () => {
    reconnectDelay = 1_000
    log(`已连接 ${ENDPOINT}`)
    emit(Events.Ready, {
      hostname: process.env.HOSTNAME ?? 'unknown',
      platform: process.platform,
      pid: process.pid,
      // 云端据此把绝对路径翻译成相对标识，因而无需知道本机的磁盘布局。
      workRoot: resolve(workRoot()),
    })
  })

  socket.on('message', (raw: unknown) => {
    const msg = parse(raw)
    if (msg !== undefined) route(msg)
  })

  socket.on('close', () => {
    log('连接断开，正在重连…')
    cleanup()
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
  })

  socket.on('error', (error: Error) => { log('连接错误:', error.message) })
}

log(`端侧 daemon 启动 | endpoint=${ENDPOINT} | workRoot=${resolve(workRoot())}`)
connect()

process.on('SIGINT', () => {
  log('收到 SIGINT，清理进程')
  cleanup()
  ws?.close()
  process.exit(0)
})
