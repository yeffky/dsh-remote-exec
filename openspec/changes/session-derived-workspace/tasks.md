## 1. Session-derived workspace resolution

- [x] 1.1 Read the repository from Superagent's existing binding and keep an optional standalone fallback. Satisfies `remote-execution`: Superagent deployments do not duplicate project configuration.
- [x] 1.2 Resolve Ticket ids from `DSH_SESSION_ID=worker-<ticketId>` and merge explicit values with Superagent's binding or the standalone fallback. Satisfies `remote-execution`: each request is bound to its calling Ticket without model repetition.
- [x] 1.3 Preserve strict-mode rejection and generic Shell compatibility. Satisfies `remote-execution`: missing context never falls back for dedicated Superagent profiles.

## 2. Operator documentation

- [x] 2.1 Document automatic lookup of the Superagent binding and Session-derived Ticket mapping. Satisfies `remote-execution`: operators can deploy the plugin without repeating project identity.
