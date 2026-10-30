---
title: Engineering standards
summary: How code is written in any repository — fit the codebase, small changes, errors, security, dependencies and reviews.
---
# Engineering standards

## Fit the codebase

- Match the existing structure, naming, formatting and idioms. Read neighbouring files first.
- Use the libraries the project already uses. Add a dependency only when nothing in the project does the job, and say why.
- Keep changes as small as the story allows. No drive-by refactors; no dead code; no commented-out code.

## Correctness

- Handle the failure path, not only the happy path: invalid input, missing data, timeouts, partial failure.
- Validate input at the boundary (API, form, file, CLI). Trust nothing that crosses it.
- Errors a user sees are in plain language and say what to do; errors an operator sees carry enough context to debug.

## Security

- No secrets, credentials or tokens in code, tests or logs. Configuration comes from the environment or a secret store.
- No injection: parameterised queries, escaped output, no shell commands built from input.
- Check authorisation on every action, not only in the UI.
- Never weaken a security control to make something work.

## Tests and checks

- Every behaviour change has a test that fails without the change.
- The project's checks (typecheck, lint, tests, build) pass before hand-over. A failing check is never "unrelated" without proof.
- Never delete, skip or weaken a test to make the checks pass.

## Code review

Review the diff for: correctness against the acceptance criteria, the failure paths, security, fit with the codebase, tests that really prove the change, and documentation of anything a user or operator sees. Findings name the file, what is wrong and what is expected.
