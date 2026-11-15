## Problem Statement

Superagent worker shell calls do not always carry the repository and Ticket environment variables that the remote-exec plugin currently expects. A dedicated profile with `requireWorkspaceContext` therefore rejects valid worker calls. Superagent already has a GitHub repository binding, and DSH supplies the calling Session id to each shell request; operators should not need to repeat this context in tasks or configure it twice.

## Solution

Read the repository from Superagent's existing optional `orchestrator` Source Context and derive the Ticket id from `DSH_SESSION_ID=worker-<ticketId>`. Combine them into the existing workspace RPC. Keep an optional static repository setting only as a fallback when the plugin runs without Superagent. Preserve explicit request values, generic Shell compatibility, and fail-closed behavior for strict profiles.

## User Stories

1. As an operator, I want the remote Shell plugin to use Superagent's existing GitHub repository binding, so that I do not configure the same repository twice.
2. As a Superagent Ticket worker, I want the plugin to resolve my Ticket id from my DSH Session id, so that commands automatically use my own remote checkout.
3. As a Ticket worker, I want all calls from the same worker Session to map to the same daemon directory, so that commands can share the Ticket's checkout.
4. As an operator running concurrent Tickets, I want each worker Session id to produce a distinct remote workspace, so that parallel work stays isolated by Ticket.
5. As an operator, I want an explicitly supplied repository to override the Superagent binding, so that compatible integrations that already provide it keep working.
6. As an operator, I want an explicitly supplied Ticket id to override the Session-derived value, so that existing explicit integrations retain their behavior.
7. As an operator, I want partial context completed only from the Superagent binding or a valid Worker Session id, so that harmless omissions do not require model-authored repetition.
8. As an operator, I want malformed repository names and Ticket ids rejected before an RPC is sent, so that invalid workspace identities do not reach the daemon.
9. As an operator, I want a strict Superagent profile to reject router or unrelated Session calls without workspace identity, so that they cannot silently execute in the default directory.
10. As a general remote Shell user, I want profiles without strict workspace mode and without Superagent metadata to keep their current directory behavior, so that this feature does not affect ordinary commands.
11. As an operator, I want daemon preparation and origin verification to remain in force for automatically resolved workspaces, so that a Session mapping cannot bypass checkout validation.
12. As an operator, I want the cloud host's absolute Ticket directory kept out of the daemon request, so that the execution host continues to use its own `workRoot` layout.
13. As an operator, I want `workspaceRepository` to remain an optional standalone fallback, so that the plugin still supports deployments without Superagent.

## Implementation Decisions

- Read Superagent's current GitHub repository from the optional `orchestrator` Source Context without making it a required dependency for general remote Shell profiles.
- Keep `workspaceRepository` optional as a standalone fallback, validated as a GitHub `owner/name` identifier.
- Resolve Ticket ids only from an explicit `DSH_SUPERAGENT_TICKET` or a DSH-managed Session id exactly matching `worker-<valid-ticket-id>`.
- Use explicit request repository first, then Superagent's current binding, then the standalone fallback. Use explicit Ticket id before the Session-derived value.
- Do not infer a Ticket from the cloud `workdir` basename, command text, daemon filesystem contents, or a Git remote.
- Continue sending resolved workspaces through the existing `workspaceExec` RPC so daemon preparation, path checks, and origin verification remain unchanged.
- Keep ordinary Shell requests on the existing `shellExec` path when workspace metadata is absent and strict mode is disabled.
- Preserve `requireWorkspaceContext` as the gate that rejects requests that cannot resolve a complete workspace.

## Testing Decisions

- The primary seam is `RemoteShellExecutor.execute` and its outgoing RemoteHub RPC; assertions should observe the RPC method, Ticket directory identifier, workspace fields, and pre-RPC errors.
- Cover lookup from Superagent's existing binding, a Worker Session with only `DSH_SESSION_ID`, explicit value precedence, standalone fallback, concurrent Ticket identifiers, invalid input, a non-Worker Session under strict and general profiles, and ordinary Shell behavior.
- At the daemon integration seam, preserve the existing observable behavior: successful preparation creates the bound repository checkout, and invalid or mismatched workspaces fail before the command runs.
- Existing prior art is the Shell executor behavior suite and the daemon workspace validation/prepare flow.
- No tests are added or run in this implementation pass.

## Out of Scope

- Modifying Superagent, DSH, or its managed `shellEnv` provider.
- Router changes, worker prompt changes, multi-repository selection, or filesystem scanning to guess a project.
- Changes to daemon RPC shape, `--prepare`, credential handling, or remote filesystem boundaries.

## Further Notes

- DSH's shell environment documentation describes `DSH_SESSION_ID` as a managed value available to shell calls: [dsh-shell-env README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/shell-env/README.md).
- In a Superagent deployment, the existing GitHub Source binding is authoritative. `workspaceRepository` is only needed when this plugin runs without the optional Superagent service.
- The `to-spec` workflow also expects publishing an issue with the `ready-for-agent` label. The available GitHub account has read-only access to the repository, so the spec is local only; run `/setup-matt-pocock-skills` after issue-tracker write access is configured.
