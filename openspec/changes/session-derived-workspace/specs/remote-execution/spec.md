## ADDED Requirements

### Requirement: Superagent Ticket workspace can be resolved from the calling Session

The remote Shell plugin SHALL resolve a Superagent Ticket workspace from the DSH-managed calling Session id and Superagent's existing GitHub Source repository binding, without requiring the model or operator to repeat the repository or Ticket id in each shell call. A configured fallback MAY be used when the Superagent service is absent.

#### Scenario: Worker Session runs a shell command without explicit Ticket variables

- **WHEN** a shell request has `DSH_SESSION_ID` in the form `worker-<valid-ticket-id>` and the Superagent GitHub Source has a repository binding
- **THEN** the plugin sends a `workspaceExec` request
- **AND** its workspace contains the bound repository and the Ticket id from the Session id
- **AND** the daemon directory identifier is that Ticket id

#### Scenario: Explicit workspace variables are supplied

- **WHEN** a request supplies explicit repository or Ticket environment values
- **THEN** the explicit values take precedence over the Superagent binding or Session-derived Ticket id
- **AND** a missing field is filled only from the Superagent binding, standalone fallback, or valid Worker Session id
- **AND** workspace identity that remains incomplete is rejected before daemon execution

#### Scenario: Router Session has no workspace metadata

- **WHEN** a request has no explicit workspace identity and its Session id is not a Superagent Worker Session
- **THEN** a strict Superagent profile rejects the request without starting a daemon command
- **AND** a general-purpose profile preserves ordinary remote Shell behavior

#### Scenario: Superagent has no repository binding

- **WHEN** a Worker Session is identified but neither the Superagent binding nor the optional fallback provides a valid `owner/name`
- **THEN** the plugin returns a clear workspace configuration error
- **AND** it does not fall back to the default working directory
