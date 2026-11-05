/**
 * dsh-remote-exec 共享协议定义
 *
 * 云端与端侧 daemon 之间的消息契约。两端 import 同一个文件，
 * 避免协议漂移。
 *
 * 传输：WebSocket，JSON 文本帧。
 * 方向：端侧作为 client 主动连云端 server（NAT 友好）。
 */

export const PROTOCOL_VERSION = 1

/** 方法名常量，避免字符串拼写错误。 */
export const Methods = {
  ShellExec: 'shellExec',
  ShellStdin: 'shellStdin',
  Terminate: 'terminate',
}

/** 端侧 → 云端的推送事件。 */
export const Events = {
  Ready: 'ready',
  Spawned: 'spawned',
  Output: 'output',
  Exit: 'exit',
  Error: 'error',
}

/** 云端 → 端侧请求；`id` 用于匹配响应。 */
export function request(id, method, params) {
  return { jsonrpc: '2.0', id, method, params }
}

/** 端侧 → 云端成功响应。 */
export function result(id, value) {
  return { jsonrpc: '2.0', id, result: value ?? null }
}

/** 端侧 → 云端错误响应。 */
export function failure(id, message, code = -32000) {
  return { jsonrpc: '2.0', id, error: { code, message: String(message) } }
}

/** 端侧 → 云端推送事件（无 id）。 */
export function event(method, params) {
  return { jsonrpc: '2.0', method, params }
}

/**
 * 把 DSH 的 stdio 描述转换成端侧可执行的形式。
 * `SubprocessOutputMode` 可能是 'pipe' | 'inherit' | { collect: {...} }
 */
export function normalizeStdio(stdio) {
  const norm = (mode) => {
    if (mode === 'pipe' || mode === 'inherit') return { kind: mode }
    if (mode && typeof mode === 'object' && 'collect' in mode) {
      return { kind: 'collect', maxBytes: mode.collect?.maxBytes ?? 64 * 1024 * 1024 }
    }
    // 未指定时按 pipe 处理，与 Node 默认一致
    return { kind: 'pipe' }
  }
  return {
    stdin: typeof stdio?.stdin === 'string' ? stdio.stdin : (stdio?.stdin?.kind ?? 'ignore'),
    stdout: norm(stdio?.stdout),
    stderr: norm(stdio?.stderr),
    control: stdio?.control === 'pipe' ? 'pipe' : undefined,
  }
}

/** 解析 JSON 消息，失败返回 undefined（忽略噪声帧）。 */
export function parse(raw) {
  try {
    const v = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
    return v && typeof v === 'object' ? v : undefined
  } catch { return undefined }
}