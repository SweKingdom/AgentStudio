---
title: Checks, smoke testing and release
summary: Final checks on the base branch, pre/post-release steps, smoke tests, versioning, rollback and release notes.
---
# Checks, smoke testing and release

## Release pipeline

1. **Collect** the stories in `Release Ready`. Each one is already merged into the base branch.
2. **Check scope**: every story's solution components are on the base branch, and nothing unrelated is included.
3. **Pre-release steps** from each story's manual steps (migrations, configuration, environment variables).
4. **Run the project's checks** on the base branch with `run_checks` (typecheck, lint, tests, build — whatever the project defines). A failing check blocks the release: report it to the developer and do not publish.
5. **Post-release steps**: migrations to run, configuration to set, anything an operator must do.

## Smoke testing

After the checks pass, run a short check per story — the critical path of its main AC — and record ✅ / ❌ / ⛔. A smoke ❌ blocks the release: open a Bug linked to the story and report it.

## Versioning

Semantic: `MAJOR.MINOR.PATCH` — minor per sprint/release, patch for hotfixes. The release is tagged `v{version}` in git.

## Rollback plan

Document per release: the previous tag to go back to, migrations that need a down step, data to restore, who decides.

## Release notes

```
# Release {version} — {date}
## Highlights          — 3–5 bullets in business language
## Delivered           — table: Code | Title | Category | Points
## Checks              — each check and its result on the base branch
## Smoke test results  — table: Code | Result | Note
## Known issues        — bullets, linked bugs
## Rollback plan       — short
```
