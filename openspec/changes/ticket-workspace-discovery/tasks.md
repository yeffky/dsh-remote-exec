# Tasks

## 1. Workspace identity and protocol

- [x] 1.1 Carry daemon-validated repository and Ticket metadata in a distinct workspace Shell RPC. Satisfies `remote-execution`: repository identity reaches the execution host.
- [x] 1.2 Route Superagent workspace requests by Ticket id, independent of the shell plugin's default cwd; preserve existing behavior for generic sessions. Satisfies `remote-execution`: each Ticket has a stable remote directory.
- [x] 1.3 Add `requireWorkspaceContext` for dedicated Superagent profiles to fail closed when repository or Ticket metadata is missing. Satisfies `remote-execution`: Superagent commands cannot fall back to the plugin default cwd.

## 2. Ticket checkout preparation

- [x] 2.1 Pass only allowlisted, non-secret workspace variables from the Worker Shell request to daemon `--prepare`. Satisfies `execution-sandbox`: daemon credentials are not inherited by prepare commands.
- [x] 2.2 Support creating an isolated Ticket clone from the configured GitHub repository through daemon `--prepare`. Satisfies `remote-execution`: each Ticket receives its own project workspace.
- [x] 2.3 Verify GitHub origin before starting the requested command; fail closed on missing or mismatched checkouts. Satisfies `remote-execution`: commands never silently run in the wrong repository.
- [x] 2.4 Set the worker shell cwd and `DSH_SUPERAGENT_DIR` to the prepared checkout. Satisfies `remote-execution`: the Worker can search project files.

## 3. Verification and documentation

- [ ] 3.1 Add end-to-end daemon tests for correct origin, `rg` discovery, isolated Ticket directories, and preparation failures. Satisfies `remote-execution`: workspace behavior is observable at the Shell boundary.
- [ ] 3.2 Add path traversal, symlink escape, and credential-environment tests. Satisfies `execution-sandbox`: workspace confinement and credential scrubbing are testable.
- [x] 3.3 Document daemon `--prepare` configuration for `camera-agent`, Git credential prerequisites, failure messages, and the no-fallback behavior. Satisfies both affected specs.
