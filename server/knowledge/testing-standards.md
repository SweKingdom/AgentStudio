---
title: Testing standards
summary: What a good test proves — one test per acceptance criterion, failure paths, independence, and how the checks gate delivery.
---
# Testing standards

## What to test

- At least one test per acceptance criterion, named after it.
- The failure path of every AC that has one: invalid input, missing data, a dependency that errors or times out.
- Edge cases the story names: empty, one, many, limits, duplicates, concurrency where it matters.
- A bug fix gets a regression test that reproduces the reported steps and fails before the fix.

## How to test

- Use the project's own test framework and layout; put tests where the project keeps them.
- Tests are independent and repeatable: no order dependence, no shared mutable state, no real network or clock unless the project already does that.
- Assert outcomes, not implementation details. A test without an assertion proves nothing.
- Keep test data small and explicit in the test.
- One test file per feature, with a test case per acceptance criterion — not a file per criterion. Reuse the project's test helpers instead of writing new ones.

## The checks gate

The project's checks (typecheck, lint, tests, build) run with `run_checks`:

- the developer runs them before `complete_development`, which refuses without a passing run;
- QA runs them on the story's branch before approving;
- the release manager runs them on the base branch before publishing.

A failing check is reported with its name, exit code and the failing output. It is fixed, never skipped.
