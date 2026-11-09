/**
 * dsh-remote-exec 共享协议定义
 *
 * 云端与端侧 daemon 之间的消息契约。两端 import 同一个文件，避免协议漂移。
 *
 * 传输：WebSocket，JSON 文本帧。
 * 方向：端侧作为 client 主动连云端 server（NAT 友好）。
 */

/** 协议版本；两端不一致时应拒绝握手而不是尽力兼容。 */
export const PROTOCOL_VERSION = 1

/** 方法名常量，避免字符串拼写错误。 */
export const Methods = {
  ShellExec: 'shellExec',
  WorkspaceExec: 'workspaceExec',
  ShellStdin: 'shellStdin',
  Terminate: 'terminate',
} as const

export type MethodName = (typeof Methods)[keyof typeof Methods]

/** 端侧 → 云端的推送事件。 */
export const Events = {
  Ready: 'ready',
  Spawned: 'spawned',
  Output: 'output',
  Exit: 'exit',
  Error: 'error',
} as const

export type EventName = (typeof Events)[keyof typeof Events]

/**
 * 一次 shellExec 请求。
 *
 * `dir` 是**相对标识**（例如工单目录的最后一段），不是绝对路径：目录根由执行
 * 主机自己决定，它把 `dir` 拼到自己的 work-root 上。云端因此不需要知道执行
 * 主机的磁盘布局，这正是原文「按需读取其中的上下文」的含义。
 */
export interface ShellExecParams {
  spawnId: string
  command: string
  /** 相对于执行主机 work-root 的目录标识；空串表示 work-root 本身。 */
  dir: string
  /** Superagent Ticket 的远程工作区身份，不包含云端绝对路径。 */
  workspace?: {
    repository: string
    ticket: string
    name?: string
    number?: string
    prHead?: string
  }
  env?: Record<string, string>
  graceMs?: number
  stdin?: string
}

/** 终止请求；`graceMs` 是 SIGTERM 到 SIGKILL 的宽限。 */
export interface TerminateParams {
  spawnId: string
  graceMs?: number
}

/**
 * 端侧连上后上报的环境事实。
 *
 * `workRoot` 是执行主机存放工单目录的根，云端用它把绝对路径翻译成相对标识。
 * 这是环境探测的最小形态：云端只问「你的根在哪」，不问「你有什么工具链」。
 */
export interface ReadyParams {
  hostname: string
  platform: string
  pid: number
  workRoot: string
}

/** 子进程已启动。 */
export interface SpawnedParams {
  spawnId: string
  pid?: number
}

/** 一段输出。`offset` 是整流的字节偏移，云端据此实现非消费式读取。 */
export interface OutputParams {
  spawnId: string
  stream: 'stdout' | 'stderr'
  offset: number
  /** base64 编码的原始字节，避免 UTF-8 多字节字符被块边界切断。 */
  data: string
}

/** 子进程结束；`exitCode` 与 `signal` 至少一个表达结局。 */
export interface ExitParams {
  spawnId: string
  exitCode: number | null
  signal: string | null
  error?: string
}

interface RequestEnvelope<T> {
  jsonrpc: '2.0'
  id: number
  method: string
  params: T
}

interface EventEnvelope<T> {
  jsonrpc: '2.0'
  method: string
  params: T
}

interface ResultEnvelope<T> {
  jsonrpc: '2.0'
  id: number
  result: T
}

interface ErrorEnvelope {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string }
}

/** 云端 → 端侧请求；`id` 用于匹配响应。 */
export function request<T>(id: number, method: string, params: T): RequestEnvelope<T> {
  return { jsonrpc: '2.0', id, method, params }
}

/** 端侧 → 云端成功响应。 */
export function result<T>(id: number, value?: T): ResultEnvelope<T | null> {
  return { jsonrpc: '2.0', id, result: value ?? null }
}

/** 端侧 → 云端错误响应。 */
export function failure(id: number, message: unknown, code = -32000): ErrorEnvelope {
  return { jsonrpc: '2.0', id, error: { code, message: String(message) } }
}

/** 端侧 → 云端推送事件（无 id）。 */
export function event<T>(method: string, params: T): EventEnvelope<T> {
  return { jsonrpc: '2.0', method, params }
}

/** 解析 JSON 消息，失败返回 undefined（忽略噪声帧）。 */
export function parse(raw: unknown): Record<string, unknown> | undefined {
  try {
    const text = typeof raw === 'string' ? raw : String(raw)
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
