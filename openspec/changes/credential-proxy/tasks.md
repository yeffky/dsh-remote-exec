# Tasks

## 1. 令牌签发

- [ ] 1.1 实现令牌 claim 结构与签名/验签，密钥在内存中生成、不落盘。满足 `credential-proxy`：Scoped tokens are constrained per ticket。
- [ ] 1.2 在工单创建时签发令牌，绑定仓库、分支模式、操作集与过期时间。满足同上。
- [ ] 1.3 单元测试：claim 缺字段、过期、签名错误分别被拒绝。

## 2. 凭据代理

- [ ] 2.1 实现 git 代理端点，按固定顺序校验（exp → 签名 → aud → repo → ops → refs）。满足 `credential-proxy`：Scoped tokens are constrained per ticket。
- [ ] 2.2 校验通过后注入真 token 并转发到上游，真 token 只存在于转发瞬间的内存中。满足 `credential-proxy`：The execution host never holds a real credential。
- [ ] 2.3 拒绝时返回可读错误并写入审计，记录失败的 claim 名与请求摘要。满足 `credential-proxy`：Proxy refusals are visible。
- [ ] 2.4 集成测试：用有效令牌推送成功；越权仓库/分支/操作/过期各返回拒绝且审计有记录。

## 3. 执行主机改造

- [ ] 3.1 执行主机侧 git 配置改为指向代理，凭据助手只返回受限令牌。满足 `credential-proxy`：The execution host never holds a real credential。
- [ ] 3.2 移除执行主机上的真实凭据文件或改为不可达。满足同上。
- [ ] 3.3 集成测试：在执行主机上 `env`、`cat` 凭据路径、`git config --list`，断言输出中不含真 token。

## 4. 脱敏

- [ ] 4.1 实现脱敏器，覆盖 provider token、JWT、配置登记值。满足 `credential-proxy`：The model context never contains a credential。
- [ ] 4.2 接入工具结果与审计写入路径。满足 `execution-policy`：Every execution is audited（Audit content avoids secrets）。
- [ ] 4.3 单元测试：各类敏感形态被替换，普通文本不受影响。

## 5. 验证与文档

- [ ] 5.1 端到端：从飞书触发一个工单，其 `git push` 经代理成功，审计有对应条目。
- [ ] 5.2 反向验证：手工用一个过期令牌推送，确认被拒且审计记录 claim。
- [ ] 5.3 更新 `docs/002-security-model.md`，写明信任边界与本变更加固的范围。
- [ ] 5.4 在 README 记录「代理是单点」这一已知取舍。