## ADDED Requirements

### Requirement: Ticket working directories stay under work-root

The daemon SHALL resolve Ticket working directories below its configured `workRoot` and SHALL reject path traversal and symlink escapes before running commands.

#### Scenario: A Ticket directory is resolved

- **WHEN** a Ticket has a valid identifier
- **THEN** the daemon resolves its working directory below `workRoot`
- **AND** the Worker shell starts in that Ticket directory.

#### Scenario: A Ticket path escapes the configured root

- **WHEN** a Ticket identifier or symlink resolves outside `workRoot`
- **THEN** the daemon refuses preparation
- **AND** returns a workspace boundary error without starting the command.

### Requirement: Workspace preparation receives no daemon credentials

The daemon SHALL run its workspace preparation command with a credential-scrubbed environment and pass only allowlisted, non-secret execution variables from the Shell request.

#### Scenario: Prepare inspects its environment

- **WHEN** the workspace preparation command prints its environment
- **THEN** credential-shaped environment variables, SSH agent variables, and unlisted worker variables are absent
- **AND** only the repository and Ticket metadata required for preparation are added from the Shell request.
- **AND** Git may still use the daemon host's configured credential helper to clone a private repository.
