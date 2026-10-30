---
title: Documentation standards
summary: Per-task document, living user manual, technical overview, changelog and release notes formats.
---
# Documentation standards

Two kinds of documents:

## 1. Per-task document (one per story, `task_doc`)

```
# {CODE}: {Title}
**Status:** … · **Category:** … · **Points:** … · **Sprint:** …

## Summary            — 2–3 sentences, what changed for the user
## What was built     — bullets: components and their purpose (API names)
## How it works       — short walkthrough of the behaviour, per AC
## How to test        — copied/condensed from the story
## Deployment notes   — pre/post steps, migrations, configuration to set
## Known limitations  — anything out of scope or deferred
```

## 2. General documents (living — updated after every task)

| Kind | Audience | Content |
|---|---|---|
| `user_manual` | End users (agents, dispatchers, managers) | Task-oriented chapters: "How to …". Plain language, numbered steps, field names as users see them (labels, not API names), tips and warnings. When a story changes behaviour, update the relevant chapter **in place** — don't append a changelog to the manual. Keep a table of contents. |
| `technical_overview` | Operators / developers | Architecture, data model, APIs, integrations, configuration, deployment notes. One section per module/area, updated in place. |
| `changelog` | Everyone | Reverse-chronological list: `{date} — {CODE} {title}: one line`. |
| `release_notes` | Business + IT | Written by the release manager at release time: highlights, stories delivered, manual steps, known issues. |

Rules: write in English, plain language, short paragraphs, tables over prose for reference data, no marketing language. Always return the **complete** updated document when updating a general document (it replaces the previous version).
