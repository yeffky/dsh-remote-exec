# Execution policy

## Purpose

Let an operator decide what a remote command may do, with layered settings that a narrower scope can tighten but never loosen.

## Requirements

### Requirement: Three layers combine by strictest wins

The plugin SHALL resolve an effective policy from team, group, and member settings, taking the strictest value of each knob.

#### Scenario: A member tightens the team default

- **WHEN** the team allows execution and a member sets `never`
- **THEN** that member's commands are refused
- **AND** other members are unaffected.

#### Scenario: A group cannot loosen the team

- **WHEN** the team sets `never` and a group sets `always`
- **THEN** the effective value stays `never`.

#### Scenario: Settings are absent

- **WHEN** no policy is configured at any layer
- **THEN** the effective execution policy is `ask`
- **AND** the effective network mode is `deny`.

### Requirement: Approval gates precede execution

The plugin SHALL ask for approval before running a command whose policy resolves to `ask`.

#### Scenario: A command needs approval

- **WHEN** the effective policy is `ask` and a command would run
- **THEN** the command waits for an approval naming the command, its directory, and its requested destinations
- **AND** the command runs only after approval
- **AND** a refusal ends the command without running it.

#### Scenario: Approval is never granted

- **WHEN** an approval request is refused or expires
- **THEN** the command does not run
- **AND** the result reports the refusal.

### Requirement: Every execution is audited

The plugin SHALL record each executed command with the fields an operator needs to review it.

#### Scenario: An operator reads the audit log

- **WHEN** an operator reads the audit log after a command
- **THEN** the entry carries the ticket, the command, the directory, the resolved policy, the approval outcome, the exit status, and the duration.

#### Scenario: Audit content avoids secrets

- **WHEN** a command's text or output would contain a credential
- **THEN** the audit entry records a redacted form.