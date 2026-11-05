/**
 * dsh-remote-exec：Cordis 插件（路径 B —— 远程 ctx.shell）
 *
 * 继承 DSH 的 ShellExecutor 抽象 seam，注册为 ctx.shell，
 * 替换 bash-local / bash-sandbox。加载后 Executor 的 bash 命令在端侧执行，
 * 而 ctx.subprocess（setup 探测、session 恢复）保持本地。
 *
 * 配置：
 *   - id: bash-remote
 *     name: dsh-remote-exec/shell
 *     config:
 *       port: 7777
 *       host: 0.0.0.0
 *       token: <shared secret>
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  port: z.number().default(7777).description('WebSocket 监听端口；端侧 daemon 主动连接此处。'),
  host: z.string().default('127.0.0.1').description('监听地址。容器内需 0.0.0.0 才能被 Docker 端口映射转发。'),
  token: z.string().default('').description('共享令牌；端侧 daemon 必须以 Bearer 提供。'),
  cwd: z.string().default('/').description('默认工作目录，被每次执行的 workdir 覆盖。'),
  timeoutMs: z.number().default(120_000).description('默认超时。'),
  maxTimeoutMs: z.number().default(600_000).description('超时上限。'),
  maxOutputBytes: z.number().default(65_536).description('stdout 采集上限。'),
  graceMs: z.number().default(3_000).description('SIGTERM→SIGKILL 宽限期。'),
})
export const inject = []
export const name = 'dsh-remote-exec-shell'

/** Cordis 插件入口。 */
export async function apply(ctx, config) {
  const cfg = Config(config ?? {})
  const { ShellExecutor } = await import('@deepseek-ai/dsh-shell')
  const { RemoteHub } = await import('./hub.mjs')
  const { RemoteShellExecutor } = await import('./shell-remote.mjs')

  // 复用主 Context 上已有的 hub；只有没有时才自己监听（注意端口会被占用）。
  // Preset 内的插件运行在 isolate 作用域，cordis 服务可能不可见，
  // 因此用一个进程级单例作为兜底（同一个 Node 进程内共享）。
  const shared = globalThis.__dshRemoteExecHub
  let hub = shared ?? ctx.get('remoteExecHub')
  if (hub === undefined) {
    hub = new RemoteHub({
      port: cfg.port,
      host: cfg.host,
      token: cfg.token,
      onPeer: (peer) => ctx.logger?.info?.(`dsh-remote-exec: 端侧设备接入 id=${peer.id}`),
    })
    try { ctx.provide('remoteExecHub') } catch { /* 已提供 */ }
    ctx.remoteExecHub = hub
    globalThis.__dshRemoteExecHub = hub
  } else {
    ctx.logger?.info?.('dsh-remote-exec: 复用已有 hub')
  }
  const remote = new RemoteShellExecutor(hub, cfg)

  class RemoteShellService extends ShellExecutor {
    /**
     * 端侧 daemon 把每次执行限制在 ticket 目录内（见 daemon 的 ALLOWED_ROOT 检查），
     * 与本地 bash-sandbox 的 workspace-write 语义一致，因此如实报告该模式；
     * permission 插件要求一个具体模式才能组合。
     */
    get sandboxMode() { return 'workspace-write' }
    resolve(request) { return remote.resolve(request) }
    execute(spec) { return remote.execute(spec) }
  }

  new RemoteShellService(ctx)

  ctx.effect(() => () => { remote.dispose() }, 'remote shell teardown')
  ctx.logger?.info?.(`dsh-remote-exec: shell 远程化，监听 ws://${cfg.host}:${cfg.port}`)
}

export default apply