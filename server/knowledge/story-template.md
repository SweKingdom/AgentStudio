---
title: Story template (DevOps pattern)
summary: How a work item is written — Description vs Acceptance Criteria vs Technical Specification, quality bar, story document set.
---
# Story template — DevOps pattern

Every User Story is written to the same template. Two audiences, two purposes:

| Section | Purpose | Audience | Length |
|---|---|---|---|
| **Description** (User Story, Background & Context, Business Rules, Dependencies, Out of Scope) | Tell readers what the story is about | Humans skimming the backlog (PO, SA, ops) | Short, plain language, bullets |
| **Acceptance Criteria** | Define done in testable terms | Humans + AI | Numbered `AC 1`, `AC 2`… one outcome each |
| **Technical Specification** | Everything needed to build without ambiguity | AI agents + developer | Deep: API names, field types, picklist values, classes, edge cases. Tables over paragraphs |

## Field-by-field

- **User Story** — ONE sentence: `As a {persona}, I want to {goal}, so that {benefit}.`
- **Background & Context** — 2–3 sentences of business context in plain language. No API names, no class names. Reference the source document once ("Source: {doc} §X").
- **Business Rules** — bullets with explicit conditions ("Only cases with priority High escalate after 4 business hours").
- **Dependencies** — what must exist before this can be built or deployed (other stories by code, data, licences, integrations).
- **Out of Scope** — bullet list, no explanations needed.
- **Acceptance Criteria** — format:
  ```
  ### AC 1: {Short title}
  {Trigger / condition} → {observable outcome}:
  - `Field__c` = `value`
  - {result}
  ```
  Rules: testable outcomes, plain language, API names only when they are the assertion itself. **No verbose Given/When/Then — go direct.** Cover the negative path (what must NOT happen) when it matters. Add source references `(SD §X)` when derived from a design document.
- **Technical Specification** — sub-sections as needed: *Modules and files* (table: Path | Change), *Data model* (table: Name | Type | Notes, plus migrations), *API* (route or function, input, output, errors), *UI* (screens, states), *Integration* (endpoint, method, payload, error semantics), *Configuration* (settings, environment variables), *Data* (migration mapping). Every enum value spelled exactly as in code. Every relationship named. Every condition that triggers behaviour explicit.

## Quality standard (Definition of Ready)

A story is ready only if it has: specific field mappings (`target.field = source.field`), explicit values (enums, formulas, defaults), clear relationships, the conditions that trigger behaviour, at least one negative/edge AC where relevant, and no open question that blocks implementation. If something is unknown, **do not invent it** — record an open question for the human and mark the story `Requires additional information`.

## Anti-pattern

❌ Dumping the technical spec into the Description "because the AI needs the context". Humans stop reading at line 20. The AI reads the Technical Specification just fine.

## Story document set (per story folder `docs/stories/{CODE}/`)

| File | Purpose |
|---|---|
| `story.md` | Full story: description, ACs, technical specification |
| `solutions-components.md` | Files and modules created/changed — bullet list grouped by module |
| `how-to-test.md` | Short test instructions: unit tests to run + one manual check per AC with **Verify:** line |
| `manual-steps.md` | Pre-deployment / post-deployment manual steps + verification (only if needed) |

## Tags

- `Pre-deploy Steps` when manual-steps has pre-deployment steps; `Post-deploy Steps` for post-deployment steps.
- Category tags are free-form but short (e.g. `Integration`, `Data`, `Reporting`).
