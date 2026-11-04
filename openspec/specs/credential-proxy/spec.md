# Credential proxy

## Purpose

Let an agent use a credential on an execution host without the real secret ever reaching that host or the model's context, so that compromising the agent loop cannot harvest every connected machine's credentials.

## Requirements

### Requirement: The execution host never holds a real credential

The plugin SHALL keep long-lived provider credentials on the agent loop's machine and issue the execution host only a scoped, expiring token.

#### Scenario: The host inspects its own environment

- **WHEN** a command on the execution host prints its environment, git configuration, and credential files
- **THEN** no provider token appears in that output
- **AND** the only credential present is a token scoped to one ticket.

#### Scenario: Git operations reach the provider

- **WHEN** the execution host pushes or fetches through the configured git remote
- **THEN** the request reaches the credential proxy on the agent loop's machine
- **AND** the proxy attaches the real provider credential before forwarding to the provider.

### Requirement: Scoped tokens are constrained per ticket

The plugin SHALL bind each issued token to one repository, one branch pattern, one operation set, and one expiry.

#### Scenario: A token is used for another repository

- **WHEN** a request presents a token whose repository claim names a different repository
- **THEN** the proxy refuses the request
- **AND** records the refusal in the audit log.

#### Scenario: A token is used beyond its branches

- **WHEN** a request presents a token whose branch claim does not cover the target ref
- **THEN** the proxy refuses the request.

#### Scenario: A token outlives its ticket

- **WHEN** a request presents a token past its expiry
- **THEN** the proxy refuses the request.

### Requirement: The model context never contains a credential

The plugin SHALL ensure that neither prompts nor tool results carry a real secret.

#### Scenario: An agent asks for a credential value

- **WHEN** an agent reads files or environment variables that would hold a credential
- **THEN** the real value is absent from the tool result
- **AND** the agent can still complete credential-using work through the proxy.

#### Scenario: A pushed command echoes a credential

- **WHEN** a command's output would contain a real credential
- **THEN** the plugin redacts it before the output reaches the agent loop.

### Requirement: Proxy refusals are visible

The plugin SHALL report every proxy refusal with the claim that failed.

#### Scenario: An operator reviews a refusal

- **WHEN** an operator reads the audit log after a refusal
- **THEN** the entry names the ticket, the requested operation, the target, and which claim refused it.