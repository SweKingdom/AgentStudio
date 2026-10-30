---
title: Work item hierarchy, states and categories
summary: Epic → Feature → User Story → Task/Bug, the ADO-style state machine, and the task categories with their meaning.
---
# Work item hierarchy, states and categories

## Hierarchy

| Type | Prefix | What it is | Size |
|---|---|---|---|
| Epic | `EP` | A business capability or outcome (e.g. "Case Management modernisation") | Months / multiple sprints |
| Feature | `FT` | A shippable slice of an Epic that a user can recognise ("Email-to-Case routing") | 1–3 sprints |
| User Story | `US` | One testable increment of value, written to the story template | ≤ 1 sprint, 1–13 points |
| Task | `TK` | Technical work without direct user value (script, setup, spike) | Hours–days |
| Bug | `BG` | A defect against delivered behaviour | — |

Every User Story has a Feature parent; every Feature has an Epic parent.

## States (board columns)

`New` → `Requires additional information` → `Ready for Refinement` → `Ready for Sprint` → `To Do` → `In Progress` → `In Peer Testing` → `Ready for UAT` → `Release Ready` → `Smoke Testing` → `Deployed (Done)`

Side states: `Blocked`, `Cancelled`, `Removed`.

Who moves what:
- Requirements analyst: creates items in `New`, moves complete ones to `Ready for Refinement`, incomplete ones to `Requires additional information`.
- Solution architect: `Ready for Refinement` → `Ready for Sprint` once the technical spec is complete.
- Delivery planner: `Ready for Sprint` → `To Do` when assigned to a sprint.
- Developer: `To Do` → `In Progress` → `In Peer Testing`.
- QA / peer tester: `In Peer Testing` → `Ready for UAT` (approved) or back to `In Progress` (changes requested).
- Technical writer: `Ready for UAT` → `Release Ready` once documentation is updated.
- Release manager: `Release Ready` → `Smoke Testing` → `Deployed (Done)`.

## Categories (one per item — drives colour on the board)

| Category | Use when the work is mostly… |
|---|---|
| `development` | Application code: services, APIs, UI components |
| `configuration` | Settings, feature flags, environment variables, infrastructure as code |
| `data_migration` | Moving/transforming data: mappings, load order, external IDs, reconciliation |
| `script` | CLI scripts, one-off data fixes, scheduled job setup |
| `integration` | Callouts, Named Credentials, Platform Events, middleware contracts |
| `security` | Authentication, authorisation, roles, secrets handling |
| `reporting` | Reports, dashboards, analytics |
| `testing` | Test automation, regression packs |
| `documentation` | Training material, manuals, process documentation |
| `devops` | Pipelines, environments, deployment tooling |
