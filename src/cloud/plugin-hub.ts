/**
 * dsh-remote-exec：连接服务
 *
 * 把执行设备的连接管理拆成独立 service（`ctx.remoteExecHub`），使同一进程内的
 * 多个插件条目共享一条连接，而无需借助 `globalThis`。
 *
 * 为什么独立：worker preset 运行在 `isolate` 作用域内，看不到主 Context 的
 * 普通服务；`Service` 在 isolate 里按名查找时，同名服务的提供者会沿 fiber 树
 * 向上查找，因此本 service 需要单独注册在能被两者共同看到的 Context 上。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RemoteHub } from './hub.ts'

export const Config = z.object({
  port: z.number().default(7777).description('WebSocket 监听端口；端侧 daemon 主动连接此处。'),
  host: z.string().default('127.0.0.1')
    .description('监听地址。容器内需 0.0.0.0 才能被 Docker 端口映射转发；默认只监听本机。'),
  token: z.string().default('').description('共享令牌；非空时端侧 daemon 必须以 Bearer 提供。'),
})

export type ConfigType = ReturnType<typeof Config>

export const name = 'dsh-remote-exec-hub'
/** 无依赖：本服务是被其他条目消费的基础设施。 */
export const inject = [] as const

/**
 * 注册 `ctx.remoteExecHub`。
 *
 * 只在首个条目上实例化；重复加载时 cordis 会因同名服务已注册而报错，这是
 * 期望行为——一条连接只应有一个监听者。
 */
export function apply(ctx: Context, config: ConfigType): void {
  const hub = new RemoteHub({
    port: config.port,
    host: config.host,
    token: config.token,
    onPeer: (peer) => { ctx.logger?.info?.('dsh-remote-exec: 端侧设备接入 id=%s', peer.id) },
  })

  ctx.provide('remoteExecHub')
  ctx.set?.('remoteExecHub', hub)

  ctx.effect(() => () => { hub.close() }, 'remote exec hub teardown')
  ctx.logger?.info?.('dsh-remote-exec: hub 监听 ws://%s:%s', config.host, config.port)
}

export default apply