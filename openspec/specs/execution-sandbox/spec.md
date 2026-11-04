# Execution sandbox

## Purpose

Confine what a command on the execution host can read, write, and reach, so that a compromised agent loop cannot use connected machines to damage the operator's environment.

## Requirements

### Requirement: Writes are confined to the ticket directory

The sandbox SHALL allow writes only inside the ticket's directory.

#### Scenario: A command writes inside its ticket

- **WHEN** a command writes a file under its ticket directory
- **THEN** the write succeeds
- **AND** the file is visible to the next command for the same ticket.

#### Scenario: A command writes outside its ticket

- **WHEN** a command writes to a path outside its ticket directory
- **THEN** the write fails with a permission error
- **AND** the target file is unchanged
- **AND** the audit log records the attempt.

#### Scenario: A command writes to a denied path inside its ticket

- **WHEN** a command writes to a path named by `denyWrite` even though it sits inside the ticket
- **THEN** the write fails.

### Requirement: Reads are denied for named sensitive paths

The sandbox SHALL deny reads of paths the configuration names, even when the containing directory is readable.

#### Scenario: A command reads an SSH key

- **WHEN** a command reads a file under a `denyRead` path such as the operator's SSH directory
- **THEN** the read fails with a permission error.

#### Scenario: A command reads ordinary project files

- **WHEN** a command reads files inside its ticket directory
- **THEN** the read succeeds.

### Requirement: Network is denied by default

The sandbox SHALL block outbound network access unless the configuration allows the destination.

#### Scenario: A command reaches an unlisted host

- **WHEN** a command connects to a host outside `allowedDomains` under `network.mode: allowlist`
- **THEN** the connection fails
- **AND** the failure is reported as a sandbox denial rather than a command failure.

#### Scenario: A command reaches an allowed host

- **WHEN** a command connects to a host inside `allowedDomains`
- **THEN** the connection succeeds through the proxy.

### Requirement: Denials are distinguished from failures

The sandbox SHALL report a denied operation as a denial, not as a generic command failure.

#### Scenario: A sandbox denial reaches the agent

- **WHEN** a command fails because the sandbox denied an operation
- **THEN** the result carries a sandbox denial marker naming the enforced mode
- **AND** the agent can tell a policy refusal from a bug in the command.

### Requirement: The sandbox does not leak the parent environment

The sandbox SHALL start each command with a scrubbed environment.

#### Scenario: A command inspects its environment

- **WHEN** a command prints its environment
- **THEN** credential-shaped variables from the daemon's own environment are absent
- **AND** harness-internal variables are absent.