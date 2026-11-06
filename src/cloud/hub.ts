/**
 * dsh-remote-exec 云端连接管理
 *
 * 管理端侧 daemon 的 WebSocket 连接：把请求发给 daemon，并把 daemon 推送的
 * 事件（spawned / output / exit）分发给对应的进程状态对象。
 *
 * 一个 daemon 连接对应一台执行设备，这是 BYOM 的基础；当前只支持单设备。
 */
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { Methods, Events, request, parse } from '../shared/protocol.ts'

const log = (...args: unknown[]): void => {
  console.log(new Date().toISOString().slice(11, 19), '[cloud]', ...args)
}

/** 子进程结局。 */
export interface ExitInfo {
  exitCode: number | null
  signal: string | null
  error?: string
}

/**
 * 云端为一次远程命令维护的状态。
 *
 * `RemoteShellProcess` 实现此接口；hub 只依赖这个契约，不感知 shell seam 的细节，
 * 这样新增其他 seam（如 fs）时不必修改连接层。
 */
export interface SpawnState {
  push(stream: 'stdout' | 'stderr', chunk: Buffer, offset: number): void
  notify(): void
  settleWith(info: ExitInfo): void
  exitResolve?(info: ExitInfo): void
}

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/** 一台端侧设备的连接。 */
export class Peer {
  readonly id: string
  readonly socket: WebSocket
  /** 尚未收到响应的请求，按请求 id 索引。 */
  private readonly pending = new Map<number, PendingCall>()
  /** 云端视角下正在跑的远程命令，按 spawnId 索引。 */
  readonly spawns = new Map<string, SpawnState>()
  private nextId = 1

  constructor(socket: WebSocket) {
    this.socket = socket
    this.id = randomUUID().slice(0, 8)
    socket.on('message', (raw: unknown) => { this.onMessage(raw) })
    socket.on('close', () => { this.onClose() })
  }

  private onMessage(raw: unknown): void {
    const msg = parse(raw)
    if (!msg) return

    const id = msg.id
    const method = msg.method

    // 响应：带 id、无 method
    if (typeof id === 'number' && method === undefined) {
      const waiter = this.pending.get(id)
      if (!waiter) return
      this.pending.delete(id)
      clearTimeout(waiter.timer)
      const error = msg.error as { message?: string } | undefined
      if (error) waiter.reject(new Error(error.message ?? 'remote call failed'))
      else waiter.resolve(msg.result)
      return
    }

    if (typeof method !== 'string') return
    const params = (msg.params ?? {}) as Record<string, unknown>
    const spawnId = typeof params.spawnId === 'string' ? params.spawnId : undefined
    const state = spawnId === undefined ? undefined : this.spawns.get(spawnId)

    switch (method) {
      case Events.Spawned:
        if (state && typeof params.pid === 'number') state.notify()
        break
      case Events.Output: {
        const stream = params.stream
        if (!state || (stream !== 'stdout' && stream !== 'stderr')) break
        const offset = typeof params.offset === 'number' ? params.offset : 0
        const data = typeof params.data === 'string' ? params.data : ''
        state.push(stream, Buffer.from(data, 'base64'), offset)
        state.notify()
        break
      }
      case Events.Exit:
        if (!state) break
        state.settleWith({
          exitCode: typeof params.exitCode === 'number' ? params.exitCode : null,
          signal: typeof params.signal === 'string' ? params.signal : null,
          ...typeof params.error === 'string' ? { error: params.error } : {},
        })
        break
      default:
        break
    }
  }

  /** 连接断开：所有未完成的工作以错误收敛，绝不静默回退。 */
  private onClose(): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('remote daemon disconnected'))
    }
    this.pending.clear()
    for (const [, state] of this.spawns) {
      state.settleWith({ exitCode: null, signal: null, error: 'remote daemon disconnected' })
    }
    this.spawns.clear()
  }

  /** 发送请求并等待响应。连接已断时立即拒绝，不排队。 */
  async call<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.socket.readyState !== 1) throw new Error('remote daemon not connected')
    const id = this.nextId++
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`remote call ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { resolve(value as T) },
        reject,
        timer,
      })
      this.socket.send(JSON.stringify(request(id, method, params)))
    })
  }
}

export interface RemoteHubOptions {
  port?: number
  host?: string
  /** 共享令牌；非空时 daemon 必须提供 Bearer。 */
  token?: string
  onPeer?(peer: Peer): void
}

/** 云端 WebSocket server，接受端侧 daemon 主动连接。 */
export class RemoteHub {
  readonly peers = new Map<string, Peer>()
  private readonly server: Server
  private readonly wss: WebSocketServer

  constructor(options: RemoteHubOptions = {}) {
    const { port = 7777, host = '127.0.0.1', token = '', onPeer } = options
    this.server = createServer()
    this.wss = new WebSocketServer({ server: this.server })

    this.wss.on('connection', (socket, req) => {
      const auth = req.headers.authorization ?? ''
      if (token && auth !== `Bearer ${token}`) {
        log('拒绝未授权连接')
        socket.close(1008, 'unauthorized')
        return
      }
      const peer = new Peer(socket)
      this.peers.set(peer.id, peer)
      log(`端侧接入 id=${peer.id}`)
      socket.on('close', () => {
        this.peers.delete(peer.id)
        log(`端侧断开 id=${peer.id}`)
      })
      onPeer?.(peer)
    })

    this.server.listen(port, host, () => { log(`WebSocket 监听 ws://${host}:${port}`) })
  }

  /** 选一台可用设备。当前只支持单设备，多设备调度留待后续变更。 */
  peer(): Peer {
    for (const [, peer] of this.peers) {
      if (peer.socket.readyState === 1) return peer
    }
    throw new Error('没有可用的端侧 daemon 连接')
  }

  get connected(): boolean {
    return [...this.peers.values()].some(p => p.socket.readyState === 1)
  }

  close(): void {
    for (const [, peer] of this.peers) {
      try { peer.socket.close() } catch { /* 已断开 */ }
    }
    this.wss.close()
    this.server.close()
  }
}