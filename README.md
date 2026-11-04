# dsh-remote-exec

Run a DeepSeek Harness agent's shell work on the machine that holds the real
execution environment, while the agent loop stays in the cloud.

> **Status: design stage.** The OpenSpec change documents are written; the
> implementation has not started. The prototype this repository replaces is
> described in `docs/000-provenance.md`.

## Why

An agent that runs in the cloud normally has to bring the working environment
with it: clone the repository, install the toolchain, copy the credentials. That
fails for the environments people actually work in — uncommitted changes, private
SDKs, internal services, vendor toolchains pinned to one machine.

This plugin inverts the trade: the agent loop keeps the model, the policy, the
tickets and the session state; the execution host keeps the environment and runs
the commands.

## What it replaces

| DSH seam | This plugin | Stays local |
| --- | --- | --- |
| `ctx.shell` | remote (execution host) | |
| `ctx.subprocess` | | yes — setup and session restore depend on it |

Replacing `ctx.subprocess` instead breaks two control-plane paths; see
`openspec/changes/remote-shell/design.md`.

## Documentation

The specification lives in `openspec/`. Read in this order:

- `openspec/specs/remote-execution/spec.md` — what remote execution must do
- `openspec/specs/credential-proxy/spec.md` — how credentials stay off the host
- `openspec/specs/execution-sandbox/spec.md` — what a command may read, write, reach
- `openspec/specs/execution-policy/spec.md` — who approves what, and what is audited
- `openspec/changes/remote-shell/` — the first change
- `openspec/changes/credential-proxy/` — the second change

## Known limitations

- **No sandbox yet.** The shell change declares `sandboxMode: workspace-write` so
  that `dsh-permission-presets` composes, but the only enforcement in that change
  is a working-directory check. The `execution-sandbox` change replaces it with a
  bubblewrap backend. Until then, treat the execution host as unconfined.
- **One execution host.** Multi-device selection is not implemented.
- **No terminal.** `spawnTerminal` is unimplemented.

## License

MIT