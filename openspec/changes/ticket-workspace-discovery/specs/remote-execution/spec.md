## ADDED Requirements

### Requirement: Ticket commands run in the configured project checkout

The plugin and daemon SHALL prepare a Ticket-specific checkout from the GitHub repository identified by the deployment and SHALL start its shell commands from that checkout.

#### Scenario: A Ticket targets camera-agent

- **WHEN** an Executor starts a Ticket with repository identity `yeffky/camera-agent`
- **THEN** the daemon's `--prepare` creates an isolated clone of that repository under the Ticket work root
- **AND** the first command runs with that checkout as its current directory
- **AND** the checkout's Git remote resolves to `yeffky/camera-agent`.

#### Scenario: The cloud Executor prepare command runs

- **WHEN** Superagent runs its configured Executor `prepare` command
- **THEN** that command runs in the cloud execution root
- **AND** remote Ticket workspace preparation remains the daemon's responsibility.

#### Scenario: The Worker searches project files

- **WHEN** the Worker runs `rg --files` or `grep` from the Ticket shell
- **THEN** the command can discover files in the Ticket checkout
- **AND** its search scope does not include unrelated daemon repositories.

#### Scenario: A dedicated Superagent profile receives no workspace context

- **WHEN** `requireWorkspaceContext` is enabled and a Shell request has no repository or Ticket metadata
- **THEN** the plugin refuses the request
- **AND** it does not run the command from its configured default `cwd`.

### Requirement: Workspace preparation fails closed

The daemon SHALL refuse to run a Ticket command when its configured repository cannot be resolved or the prepared checkout does not match the requested repository.

#### Scenario: The repository is missing

- **WHEN** the configured project root contains no checkout for the requested repository
- **THEN** preparation fails with an error naming the missing repository
- **AND** the requested command does not run in an empty directory or another checkout.

#### Scenario: The checkout has the wrong origin

- **WHEN** the prepared directory's Git remote does not match the configured repository
- **THEN** the daemon rejects the command
- **AND** the error reports an origin mismatch.

### Requirement: Each Ticket gets a distinct checkout

The daemon SHALL create a distinct Git clone for each Superagent Ticket so a command in one Ticket does not share its working tree or Git metadata with another Ticket.

#### Scenario: Two Tickets use the same repository

- **WHEN** two Ticket ids target the same configured repository
- **THEN** the daemon prepares separate checkout directories
- **AND** changing a tracked file in one checkout does not change that file in the other checkout.
