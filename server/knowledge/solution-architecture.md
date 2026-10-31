---
title: Solution architecture
summary: Refining stories against an existing codebase — modules, data model, APIs, security, integrations, decisions and risks.
---
# Solution architecture

## Start from the code that exists

- Read the repository before deciding: its folder layout, frameworks, how similar features were built, its tests and its README.
- Follow the patterns already there. A new pattern needs a reason, written as a decision (see below).
- Prefer extending a module over adding a new one; prefer an existing dependency over a new one.
- Specify the fewest files that read well: one file per feature module until it passes about 300 lines, shared errors, types and config reused, no pass-through layers (repository, service, DTO) unless the codebase already uses them.

## Technical refinement checklist (per story)

| Area | What to specify |
|---|---|
| Modules and files | Which modules change, which files are new, where tests live |
| Data model | Tables or types, fields (name, type, nullability, default), constraints, indexes, migrations and how to roll them back |
| APIs | Routes or functions, inputs, outputs, error cases and status codes, versioning |
| UI | Screens and components, states (loading, empty, error), accessibility |
| Configuration | New settings or environment variables, their defaults and where they are documented |
| Security | Who may do this, input validation, secrets handling, data exposure |
| Integrations | Endpoint, method, payload, timeouts, retries, idempotency, error semantics |
| Volumes and performance | Expected data sizes and request rates; what must stay fast |
| Testability | How each acceptance criterion will be proven by a test |

A story is ready for development when a developer could build it from the specification without asking.

## Decisions (ADR style)

`Decision · Reason · Alternatives considered · Consequences`. One per real choice; short.

## Risks

Name each risk, its likelihood and impact, and the mitigation. Typical ones: migrations on large tables, breaking API changes, missing test coverage around the change, third-party limits.
