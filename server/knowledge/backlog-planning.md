---
title: Backlog building, prioritisation and delivery planning
summary: Estimation in story points, MoSCoW + WSJF prioritisation, dependency ordering, sprint capacity and the delivery plan document.
---
# Backlog building, prioritisation and delivery planning

## Estimation (story points, Fibonacci 1, 2, 3, 5, 8, 13)

Estimate relative effort + complexity + uncertainty, not hours. Reference scale for Salesforce work:

| Points | Typical example |
|---|---|
| 1 | Add a field to a layout, simple validation rule |
| 2 | New field + permission set + simple before-save flow |
| 3 | Record-triggered flow with a few branches, or a small Apex service with tests |
| 5 | Apex service + trigger handler + test class, or a screen flow with several screens |
| 8 | Integration callout with error handling, or a non-trivial LWC with Apex controller |
| 13 | Too big — split it. Only allowed for spikes or data migrations with many objects |

Anything > 8 should be split into smaller stories (by workflow step, business rule, data variation, or happy/unhappy path).

## Prioritisation

1. **MoSCoW** per story: `Must` (release fails without it), `Should`, `Could`, `Won't` (this release).
2. **WSJF** = (Business value + Time criticality + Risk reduction/opportunity enablement) / Job size, each component scored 1–10, job size = story points. Higher first.
3. **Priority** 1 (critical) – 4 (low), derived from MoSCoW + WSJF.
4. **Dependencies win over priority**: a story never comes before the stories it depends on. Schema/configuration and security foundations usually go first; data migration goes after the target data model exists; integrations after their objects.

## Sprint planning

- Default sprint: 2 weeks, capacity ≈ 20 points for the AI team (adjust if told otherwise).
- Fill sprints in rank order respecting dependencies; never overfill > 110% capacity.
- Give every story a global `rank` (1 = first to build).

## Delivery plan document (`delivery_plan`)

Sections: **Summary** (scope, total points, number of sprints, key risks) · **Sprint plan** table (Sprint | Stories | Points | Goal) · **Critical path** (dependency chain) · **Milestones** (MVP, UAT, go-live) · **Risks & mitigations** table · **Assumptions**.

## Definition of Done (team level)

Code + metadata built, tests ≥ 90 % coverage on new Apex, QA verdict approved with every AC ✅, task documentation written, user manual updated, included in a release manifest, smoke test passed.
