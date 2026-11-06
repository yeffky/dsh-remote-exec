/**
 * dsh-remote-exec：插件入口
 *
 * 默认导出 shell 插件，即把 `ctx.shell` 换成远程实现。连接服务是它依赖的
 * 独立条目，需单独加载：
 *
 * ```yaml
 * - id: remote-exec-hub
 *   name: dsh-remote-exec/hub
 *   config: { port: 7777, host: 0.0.0.0, token: <secret> }
 * - id: bash-remote
 *   name: dsh-remote-exec
 *   config: { cwd: /work }
 * ```
 *
 * 不替换 `ctx.subprocess`：它被 setup 探测与会话恢复共用，替换它会让控制面
 * 跑到执行主机上。
 */
export { apply, Config, inject, name, default } from './cloud/plugin-shell.ts'