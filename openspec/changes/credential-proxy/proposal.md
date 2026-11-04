# Proposal: 凭据代理与受限令牌

## Why

现在执行主机上的 git 通过 `gh-agent` 凭据助手读取真实 token。这带来两个独立风险：

1. **日常泄露**：token 出现在执行主机的环境里，任何一个命令（含被提示词注入诱导的命令）都能读到它。
2. **入侵放大**：云端 Agent Loop 一旦被攻破，攻击者可以直接从执行主机取走 token，用它访问 GitHub。

super-agent 原文第 8.4 节把这两条列为开放问题，并明确要求「让 Agent 能够在完全不接触凭据本身的情况下使用凭据」。本变更是对该要求的第一次落地。

用户价值：操作者可以放心把带有真实凭据的机器接入云端 Agent，而不必承担凭据被云端泄露的风险。

## What Changes

- 执行主机不再持有真 token，只持有**按工单签发、会过期、限定仓库与分支**的受限令牌。
- 所有 git 出网流量改走云端**凭据代理**，由代理校验后注入真 token。
- 代理的每次拒绝都写入审计日志，记录失败的 claim。
- 执行主机侧改造：`worker-gitconfig` 指向代理，凭据助手只回受限令牌。
- 工具结果与审计日志做敏感值脱敏。

## Impact

- Affected specs: `credential-proxy`（新增）、`execution-policy`（审计字段）、`remote-execution`（失败语义）
- Affected code: 新增 `src/control/credentials.ts`、`src/control/proxy.ts`；改造 `src/daemon/credential.ts`
- Depends on: 远程 shell 通道（已实现原型）、工单目录与工单 id 的可用性
- Excludes: 多用户账号体系、非 GitHub 提供商、令牌轮换策略、UI

## Risks

- **代理成为单点**：云端不可用时执行主机无法推送。这是脑手分离的取舍，脑不可用则手不该独立行动。
- **代理自身被攻破**：代理持有真 token，是新的高价值目标。缓解措施是代理只做转发与校验，不落盘、不记录真值。