/**
 * dsh-remote-exec：shell 插件
 *
 * 把 `ctx.shell` 换成远程实现，使 `tool-bash` 的命令在执行主机上运行，而
 * `ctx.subprocess`（setup 探测、会话恢复）保持本地。
 *
 * 配置：
 *   - id: bash-remote
 *     name: dsh-remote-exec
 *     config:
 *       cwd: /work
 *       requireWorkspaceContext: true
 *       timeoutMs: 5000
 *       maxTimeoutMs: 5000
 *
 * 连接由 `dsh-remote-exec/hub` 条目提供（`ctx.remoteExecHub`）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import z from '@deepseek-ai/schemastery'
import type { RemoteHub } from './hub.ts'
import { RemoteShellExecutor } from './shell-remote.ts'

export const Config = z.object({
  cwd: z.string().default('/').description('默认工作目录；每次执行的 workdir 可覆盖它。'),
  requireWorkspaceContext: z.boolean().default(false).description('专用于 Superagent 时要求每条命令都携带仓库与 Ticket 身份，缺少时拒绝默认 cwd。'),
  timeoutMs: z.number().default(120_000).description('默认超时，毫秒。'),
  maxTimeoutMs: z.number().default(600_000).description('超时上限，毫秒。'),
  maxOutputBytes: z.number().default(65_536).description('标准输出采集上限，字节。'),
  graceMs: z.number().default(3_000).description('SIGTERM 到 SIGKILL 的宽限期，毫秒。'),
})

export type ConfigType = ReturnType<typeof Config>

export const name = 'dsh-remote-exec-shell'
/** 依赖连接服务；缺少时本条目保持 pending 而不是自行监听端口。 */
export const inject: string[] = ['remoteExecHub']

/**
 * Cordis 插件入口。
 *
 * 继承 `ShellExecutor` 并注册为 `ctx.shell`。一个 Context 只能有一个 shell
 * 实现，因此部署时需禁用本地实现（`bash-sandbox` / `bash-local`）。
 */
export function apply(ctx: Context, config: ConfigType): void {
  // 服务值是 RemoteExecHub 实例，底层连接在其 hub 字段上。
  // 用属性访问而非 ctx.get：cordis 的 Proxy 只在属性读取时按 inject 解析服务。
  const service = (ctx as unknown as { remoteExecHub?: { hub?: RemoteHub } }).remoteExecHub
  const hub = service?.hub
  if (hub === undefined) throw new Error('dsh-remote-exec: 缺少 remoteExecHub，请先加载 dsh-remote-exec/hub')

  const remote = new RemoteShellExecutor(hub, config)

  class RemoteShellService extends ShellExecutor {
    /**
     * 端侧 daemon 把执行限制在 `--work-root` 之下，与本地沙箱的
     * `workspace-write` 语义相当，因此报告该模式。
     *
     * 注意：这一声明目前**不完整**——daemon 只做工作目录检查，没有文件系统
     * 与网络隔离。真正的沙箱由 `execution-sandbox` 变更补齐，在那之前不应
     * 把这个值当作安全保证。
     */
    override get sandboxMode(): 'workspace-write' {
      return 'workspace-write'
    }

    override resolve(request: ShellExecRequest): ShellExecSpec {
      return remote.resolve(request)
    }

    override execute(spec: ShellExecSpec): Promise<ShellExecution> {
      return remote.execute(spec)
    }
  }

  // ShellExecutor 的构造函数固定注册为 ctx.shell，无需传服务名。
  new RemoteShellService(ctx)

  ctx.effect(() => () => { remote.dispose() }, 'remote shell teardown')
  ctx.logger?.info?.('dsh-remote-exec: ctx.shell 已替换为远程实现')
}

export default apply
