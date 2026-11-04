# Remote execution

## Purpose

Move a DeepSeek Harness agent's shell and filesystem work from the machine running the agent loop to a machine that holds the real execution environment, without the agent loop needing filesystem access to that machine.

## Requirements

### Requirement: Shell work runs on the execution host

The plugin SHALL execute shell commands through `ctx.shell` on a connected execution host rather than in the agent loop's process.

#### Scenario: A command runs on the execution host

- **WHEN** an agent runs a shell command and an execution host is connected
- **THEN** the command executes on that host
- **AND** its standard output, standard error, and exit status reach the agent loop
- **AND** the hostname reported by the command is the execution host's, not the agent loop's.

#### Scenario: No host is connected

- **WHEN** an agent runs a shell command and no execution host is connected
- **THEN** the command fails with an error naming the missing host
- **AND** the agent loop does not fall back to running the command locally.

### Requirement: The agent loop keeps control-plane work

The plugin SHALL leave `ctx.subprocess` and every control-plane probe on the agent loop's machine.

#### Scenario: Setup probes the account CLI

- **WHEN** deployment setup verifies the agent's GitHub CLI or Feishu bot
- **THEN** the probe runs on the agent loop's machine
- **AND** the execution host is not contacted.

#### Scenario: A session is restored

- **WHEN** the agent loop restores a stored session after a restart
- **THEN** session restoration completes without contacting the execution host
- **AND** the plugin does not replace `ctx.subprocess`.

### Requirement: Shell semantics match the local executor

The plugin SHALL preserve the `ShellExecutor` contract that `dsh-bash-local` provides.

#### Scenario: A command times out

- **WHEN** a command exceeds its resolved `timeoutMs` under `onExpiry: 'kill'`
- **THEN** the execution host terminates the process tree
- **AND** the result reports `timedOut: true` and `aborted: false`.

#### Scenario: A caller aborts a command

- **WHEN** the caller's `AbortSignal` fires before the command exits
- **THEN** the execution host terminates the process tree
- **AND** the result reports `aborted: true`.

#### Scenario: Output is read incrementally

- **WHEN** a caller reads output twice through `readOutput`
- **THEN** the second read returns only output produced after the first
- **AND** a concurrent `observed` reader at its own offset receives the full stream without consuming the `readOutput` cursor.

### Requirement: Output volume is bounded

The plugin SHALL bound the bytes it carries from the execution host to the agent loop.

#### Scenario: A command prints a large file

- **WHEN** a command writes more than the configured `maxOutputBytes` to standard output
- **THEN** the agent loop receives the bounded tail
- **AND** the result marks the output truncated
- **AND** the connection stays open for later commands.

### Requirement: Host disconnection is fail-closed

The plugin SHALL fail in-flight work when the execution host disconnects.

#### Scenario: The host drops mid-command

- **WHEN** the execution host disconnects while a command is running
- **THEN** the pending result settles with an error naming the disconnection
- **AND** no new command starts until a host reconnects.

#### Scenario: A host reconnects

- **WHEN** an execution host reconnects after a disconnection
- **THEN** later commands run on that host
- **AND** the failed commands from the earlier connection are not retried automatically.