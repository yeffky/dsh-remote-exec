/**
 * dsh-remote-exec：连接服务
 *
 * 把执行设备的连接管理注册为 `ctx.remoteExecHub`，使同一进程内的多个插件条目
 * 共享一条连接，而无需借助 `globalThis`。
 *
 * 为什么拆成独立条目：worker preset 运行在 `isolate` 作用域内，看不到主 Context
 * 的普通服务；把连接做成命名服务后，`isolate` 内的条目仍能按名解析到它。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
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
export const inject: string[] = []

/**
 * 连接服务。
 *
 * `Service` 的构造会把实例注册到 `ctx` 的指定名字下，并在所属 fiber 卸载时自动
 * 注销，因此不需要手写 `provide`。服务值就是本实例，`hub` 暴露底层连接对象。
 */
export class RemoteExecHub extends Service<never> {
  readonly hub: RemoteHub

  constructor(ctx: Context, config: ConfigType) {
    super(ctx, 'remoteExecHub')
    this.hub = new RemoteHub({
      port: config.port,
      host: config.host,
      token: config.token,
      onPeer: (peer) => { ctx.logger?.info?.('dsh-remote-exec: 端侧设备接入 id=%s', peer.id) },
    })
    ctx.effect(() => () => { this.hub.close() }, 'remote exec hub teardown')
    ctx.logger?.info?.('dsh-remote-exec: hub 监听 ws://%s:%s', config.host, config.port)
  }
}

export function apply(ctx: Context, config: ConfigType): void {
  // 构造即注册；实例本身就是 ctx.remoteExecHub。
  new RemoteExecHub(ctx, config)
}

export default apply