# 000 Provenance

本文件记录本仓库的来历与设计依据，使后续每个决策都能回溯到它的理由。

## 来源

本仓库从一个原型演化而来，原型位于
`dsh-superagent` 部署目录下的 `remote-exec`，它与 DSH 源码的调研记录一起构成
了本仓库设计文档的原始依据。

原型验证了两件事，本仓库的设计直接建立在它们之上：

1. **替换 `ctx.subprocess` 会破坏控制面。** 实测表现为 setup 探测在端侧找不到
   `gh-agent`，以及会话恢复在 `dsh-agent-preset-registry` 内抛出
   `Cannot read properties of undefined (reading 'parent')`。
2. **替换 `ctx.shell` 可行。** 原型在真实 super-agent 上执行 `hostname`，
   返回值是端侧主机名（`DESKTOP-3P0UU25`），而云端主机名是 `VM-0-17-centos`。

第二条是本仓库存在的直接理由；第一条是 `remote-shell` 变更选择 `ctx.shell` 的理由。

## 设计依据

### super-agent 设计文章

- **第 5.2 节** 提出「让 Agent Loop 在云端运行，而让重状态的执行环境留在原地，
  仅在端侧部署一个不保存会话状态的轻量 daemon」。本仓库的模块划分直接对应这句话。
- **第 8.4 节** 是本文的开放问题章节，明确指出第 5 节的方案
  「默认建立在云端与端侧环境彼此受信任的前提之上」，并列出两条风险：
  - 云端被攻破后，其连接的全部端侧设备都面临被控制的风险；
  - 即使云端未被攻破，只要端侧凭据能进入模型上下文，正常执行中同样会泄露。

  `credential-proxy` 变更就是针对第二条的第一份落地；
  `execution-sandbox` 变更针对第一条。

### Grok Bot 与 Claude Code 的调研

调研记录见原型的 `docs/009-research-brain-hands.md`。可直接借鉴的部分：

| 来源 | 借鉴内容 | 本仓库对应 |
| --- | --- | --- |
| Grok Bot | 三层策略只能收紧不能放宽 | `execution-policy`：Three layers combine by strictest wins |
| Grok Bot | 逐命令审批，默认 ask | `execution-policy`：Approval gates precede execution |
| Grok Bot | 凭据留在后端，令牌不落到执行环境 | `credential-proxy` |
| Claude Code on the web | 受限凭据 + 代理注入真 token | `credential-proxy`：design.md |
| sandbox-runtime (`srt`) | bubblewrap 做文件与网络隔离 | `execution-sandbox` |

### 与两者的区别

Grok Bot 的执行默认在云端，端侧执行是一个**默认关闭的例外**，官方建议设为
`Never allow`。本仓库恰好相反：端侧执行是**唯一形态**，没有本地回退。

这个差异来自 super-agent 第 5.2 节对场景的判断——要接入的是
「用户日常使用、可能间歇在线的个人机器，上面有未提交的修改和本地凭据」。

## 命名

仓库名 `dsh-remote-exec` 取自它替换的 seam 所属的 DSH 插件前缀
（`dsh-bash-local`、`dsh-subprocess-local` 的对应物）。

## 提交约定

本仓库的提交信息遵循 `git-commit` skill 的 Conventional Commits 约定：
type 保留英文，描述与正文使用中文，非简单变更必须包含 body。

分支模型遵循 `agent-sdk-workflow` skill 的 `references/local-git-workflow.md`：
`main` 为稳定线，功能在 `feature-<短描述>` 上开发。
远端操作需逐次授权，实现、提交、本地合并的授权不构成推送授权。