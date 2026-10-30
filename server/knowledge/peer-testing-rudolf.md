---
title: Peer testing — the Rudolf method
summary: How the QA agent tests a story — plan checks from the ticket, verdict per AC, evidence, fixed verdict rules, never soften a failure.
---
# Peer testing — the Rudolf method 🦌

The Rudolf method is a structured peer-testing approach; the QA agent follows it exactly.

## 1. The ticket is the only source

Plan checks from the story: its **How to Test** if filled in; otherwise the Acceptance Criteria + technical specification. If the ticket is not clear enough to test, the verdict is **NOT TESTED — ticket unclear**, listing exactly what is missing. Code is read only to know exact labels, names and paths — never to decide what "correct" means.

## 2. Plan

One or more checks per AC. Each check: id (`AC1-1`), what to do, what to verify, test data needed. Include at least one negative check when the AC has a condition.

## 3. Execute & evidence

In this ARM the QA agent verifies by **static review of the delivered files against each AC** (and, when available, test output): the component exists, the logic implements the condition, edge cases handled, tests assert the AC outcome. Evidence = file path + what was found.

## 4. Verdict per check (fixed rules)

| Symbol | Result | Meaning |
|---|---|---|
| ✅ | `pass` | Works as the AC says, with evidence |
| ❌ | `fail` | Broken or missing — say what is wrong and where |
| ⛔ | `blocked` | Could not be tested (setup, missing info) — not a failure of the story |

A "works" without evidence becomes ⛔. **Never soften a ❌ and never upgrade a ⛔.**

## 5. Overall verdict

- All ✅ → **approved** → story to `Ready for UAT`.
- Any ❌ → **changes requested** → back to the developer with one finding per ❌: AC, what is wrong, where, expected.
- Only ✅ and ⛔ → approved with notes, ⛔ listed under "Not tested".

## 6. Code review (alongside the AC checks)

Check the standards packs: bulkification, no SOQL/DML in loops, sharing/CRUD/FLS, error logging, no hardcoded Ids, test class quality (positive/negative/bulk, assertions), naming, package.xml contains every component. Standards issues that would fail deployment or break an AC are ❌; style issues are notes.

## Report format

```
Verdict: ✅ Approved | ❌ Changes requested | 📝 Not tested
What to do: one line
| AC | Result | Note |
What's broken: one bullet per ❌
Not tested: one bullet per ⛔
```

## 7. Test report and evidence (every story, every iteration)

1. After each check, call **capture_evidence** (code, ac_ref, result, notes). It returns a Markdown image line — a screenshot of the record page with the verified fields; failures are marked with a red box.
2. Write the **test report** with `write_document` kind `test_report`, `item_code` = the story. It replaces the previous version (the history is kept), so always send the complete report:

```
# {CODE} — Test report (iteration n)
**Verdict:** ✅ Approved | ❌ Changes requested | 📝 Not tested · **Tester:** {name} · **Date:** …

## Summary
| Check | Result | Evidence |
|---|---|---|

## Checks
### AC 1: {title} — ✅ Works
**Steps:** numbered, what you did
**Expected:** … **Found:** …
![…](evidence/ac-1-…svg)

## What to do        ← only when something failed: one bullet per ❌ for the developer
## Not tested        ← ⛔ checks and why
```

3. The developer receives this report on rework, and it stays attached to the task — write it for them: precise, reproducible, with the evidence next to each finding.
