# dsh-remote-exec

Run a DeepSeek Harness agent's shell work on the machine that holds the real
execution environment, while the agent loop stays in the cloud.

> **Status: shell execution implemented and unit-tested; not yet verified on a
> live DSH deployment.** See `openspec/changes/remote-shell/tasks.md` for exactly
> what is and is not done.

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

Replacing `ctx.subprocess` instead breaks two control-plane paths; the measured
difference is in [`docs/001-architecture.md`](docs/001-architecture.md).

## Install and configure

```sh
pnpm install
pnpm build
```

Two profile entries are needed. The first owns the connection; the second swaps
the shell implementation:

```yaml
- id: remote-exec-hub
  name: dsh-remote-exec/hub
  config:
    port: 7777
    host: 0.0.0.0        # 0.0.0.0 only inside a container that maps the port
    token: <shared secret>

- id: bash-remote
  name: dsh-remote-exec
  config:
    cwd: /work
    requireWorkspaceContext: true # set for a dedicated Superagent profile
    timeoutMs: 5000
    maxTimeoutMs: 5000
```

The local shell implementation must be disabled, because a context holds only one
`ctx.shell`:

```yaml
- id: bash-sandbox
  disabled: true
```

## Start the execution host

```sh
node lib/daemon.js \
  --endpoint ws://<agent-loop-host>:7777 \
  --token <shared secret> \
  --work-root /opt/state/superagent/work \
  --prepare 'git clone --no-hardlinks "https://github.com/${DSH_SUPERAGENT_GITHUB_REPOSITORY}.git" "$DIR" && if [ -n "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-}" ]; then git -C "$DIR" fetch --no-tags origin "$DSH_SUPERAGENT_GITHUB_PR_HEAD" && git -C "$DIR" checkout --detach FETCH_HEAD; fi'
```

The daemon connects out, so the execution host needs no inbound port and works
behind NAT. It keeps no state: restarting it only reconnects.

`--work-root` is the only boundary enforced today — a command whose `cwd` falls
outside it is refused before it runs.

Set `requireWorkspaceContext: true` on a shell plugin dedicated to Superagent.
This makes missing repository or Ticket metadata a visible failure instead of
falling back to the plugin's default `cwd`. Leave it false for general-purpose
remote Shell sessions.

For a Superagent Executor, each remote Ticket directory is keyed by its Ticket id.
The shell plugin forwards the configured repository and Ticket metadata, and the
daemon runs `--prepare` on the execution host when that directory is first used.
The example clones that repository directly into the Ticket directory, so the
Worker starts inside the checkout and can search it with `rg` or `grep`. Before
each command, the daemon verifies that `origin` matches the configured repository.
If the clone fails or the repository does not match, the command is rejected; it
never runs in an empty directory or the plugin's checkout. Ticket clones remain in
`--work-root` until an operator removes them.

The clone uses Git authentication already configured on the execution host. Do not
put a personal access token in `--prepare` or its environment. Credential proxying
is not implemented yet; private repository access therefore still depends on the
execution host's Git credential configuration.

## Documentation

The specification lives in `openspec/`. Read in this order:

- [`docs/000-provenance.md`](docs/000-provenance.md) — where the design comes from
- [`docs/001-architecture.md`](docs/001-architecture.md) — seam choice, trust boundary, failure semantics
- `openspec/specs/remote-execution/spec.md` — what remote execution must do
- `openspec/specs/credential-proxy/spec.md` — how credentials stay off the host
- `openspec/specs/execution-sandbox/spec.md` — what a command may read, write, reach
- `openspec/specs/execution-policy/spec.md` — who approves what, and what is audited
- `openspec/changes/remote-shell/` — the first change
- `openspec/changes/credential-proxy/` — the second change

## Known limitations

- **The sandbox declaration is incomplete.** The shell plugin reports
  `sandboxMode: 'workspace-write'` so `dsh-permission-presets` composes, but the
  only enforcement is the `--work-root` check. A running command can still read
  and write anything that user can, and reach any network. Treat the execution
  host as unconfined until `execution-sandbox` lands.
- **Credentials are still on the execution host.** `credential-proxy` has not
  been implemented, so the host's git configuration holds a real token.
- **Filesystem work is not remote.** `ctx.fs` still points at the agent loop's
  machine, so an Executor cannot see the files on the execution host.
- **One execution host.** `hub.peer()` takes the first connected device.
- **No terminal.** `spawnTerminal` is unimplemented.

## License

MIT
