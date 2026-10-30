---
title: Deployment, smoke testing and release
summary: Manifest build, check-only validation, pre/post-deploy steps, smoke tests, versioning, rollback and release notes.
---
# Deployment, smoke testing and release

## Deployment pipeline

1. **Collect** the stories in `Release Ready`.
2. **Build the manifest** (`manifest/package.xml`) from every delivered component; check no story component is missing and nothing unrelated is included.
3. **Pre-deployment steps** from each story's manual steps (data, objects that must pre-exist, licences).
4. **Validate (check-only)**: `sf project deploy validate -x manifest/package.xml -l RunLocalTests -o {sandbox}`. **Never deploy to production from the ARM.** If no org is configured, run static validation: every file has its `-meta.xml`, XML well-formed, every component in the manifest exists, every Apex class has a test class.
5. **Quick deploy / deploy** to the target sandbox only after a successful validation (human-approved).
6. **Post-deployment steps** (permission set assignments, configuration, data).

## Smoke testing

After deployment, run a short check per story — the critical path of its main AC — and record ✅ / ❌ / ⛔. A smoke ❌ blocks the release: open a Bug linked to the story and report it.

## Versioning

Semantic: `MAJOR.MINOR.PATCH` — minor per sprint/release, patch for hotfixes. Release name `R{version} — {date}`.

## Rollback plan

Document per release: components to revert (previous versions from git), destructive changes needed, data to restore (migration batch tag), who decides.

## Release notes

```
# Release {version} — {date}
## Highlights          — 3–5 bullets in business language
## Delivered           — table: Code | Title | Category | Points
## Deployment          — validation result, pre/post steps executed
## Smoke test results  — table: Code | Result | Note
## Known issues        — bullets, linked bugs
## Rollback plan       — short
```
