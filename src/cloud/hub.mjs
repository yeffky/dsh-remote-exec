#!/usr/bin/env node
/**
 * dsh-remote-exec 云端连接管理
 *
 * 管理端侧 daemon 的 WebSocket 连接，把 RPC 请求发给 daemon，
 * 并把端侧推送的事件（spawned/output/exit）分发给等待者。
 *
 * 载荷：一个 daemon 连接对应一台执行设备（BYOM 的基础）。
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Methods, Events, request, parse } from '../shared/protocol.mjs'

const require = createRequire(import.meta.url)
let WebSocketServer
try { ({ WebSocketServer } = require('ws')) } catch {
  console.error('缺少依赖 ws，请先运行: npm install ws')
  process.exit(1)
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[cloud]', ...a)

/**
 * 一台端侧设备的连接。
 * 维护：待响应请求、活跃 spawn 的输出缓冲与状态。
 */
export class Peer {
  constructor(socket, info = {}) {
    this.socket = socket
    this.id = randomUUID().slice(0, 8)
    this.info = info
    this.pending = new Map()          // requestId → { resolve, reject, timer }
    this.spawns = new Map()           // spawnId → SpawnState
    this.nextId = 1

    socket.on('message', (raw) => this.onMessage(raw))
    socket.on('close', () => this.onClose())
  }

  onMessage(raw) {
    const msg = parse(raw)
    if (!msg) return

    // 响应：带 id
    if (msg.id !== undefined && !msg.method) {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
      return
    }

    // 事件：无 id
    const spawnId = msg.params?.spawnId
    const state = spawnId ? this.spawns.get(spawnId) : undefined
    switch (msg.method) {
      case Events.Spawned:
        if (state) { state.pid = msg.params.pid; state.spawnedResolve?.(msg.params.pid) }
        break
      case Events.Output:
        if (state && msg.params.stream) {
          state.push(msg.params.stream, Buffer.from(msg.params.data ?? '', 'base64'), msg.params.offset)
          state.notify()
        }
        break
      case Events.Exit:
        if (state) {
          const info = {
            exitCode: msg.params.exitCode ?? null,
            signal: msg.params.signal ?? null,
            error: msg.params.error,
          }
          state.exitInfo = info
          state.exited = true
          // shell seam 的进程状态需要在这里落定；subprocess seam 的状态对象没有该方法。
          if (typeof state.settleWith === 'function') state.settleWith(info)
          else state.notify()
          state.exitResolve?.(info)
        }
        break
      default:
        break
    }
  }

  onClose() {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('remote daemon disconnected'))
    }
    this.pending.clear()
    for (const [, state] of this.spawns) {
      state.exited = true
      state.exitInfo = { exitCode: null, signal: null, error: 'remote daemon disconnected' }
      state.notify()
      state.exitResolve?.(state.exitInfo)
    }
  }

  /** 发送请求并等待响应。 */
  call(method, params, timeoutMs = 60_000) {
    if (this.socket.readyState !== 1) return Promise.reject(new Error('remote daemon not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`remote call ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify(request(id, method, params)))
    })
  }
}

/** 云端 WebSocket server，接受端侧 daemon 主动连接。 */
export class RemoteHub {
  constructor({ port = 7777, host = '127.0.0.1', token = '', onPeer } = {}) {
    this.host = host
    this.peers = new Map()
    this.onPeer = onPeer
    this.token = token
    this.server = createServer()
    this.wss = new WebSocketServer({ server: this.server })

    this.wss.on('connection', (socket, req) => {
      const auth = req.headers.authorization ?? ''
      if (this.token && auth !== `Bearer ${this.token}`) {
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
      this.onPeer?.(peer)
    })

    this.server.listen(port, host, () => log(`WebSocket 监听 ws://${host}:${port}`))
  }

  /** 选一台可用端侧设备（BYOM 的简化版：取第一个）。 */
  peer() {
    for (const [, peer] of this.peers) {
      if (peer.socket.readyState === 1) return peer
    }
    throw new Error('没有可用的端侧 daemon 连接')
  }

  get connected() { return [...this.peers.values()].some(p => p.socket.readyState === 1) }

  close() {
    for (const [, peer] of this.peers) { try { peer.socket.close() } catch { /* ignore */ } }
    this.wss.close()
    this.server.close()
  }
}