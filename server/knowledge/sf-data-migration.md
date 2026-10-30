---
title: Data migration
summary: Migration approach, mapping specification, load order, external IDs, validation and rollback.
---
# Data migration

## Approach (ETL in phases)

1. **Discover** — source systems, objects, volumes, data quality issues, owners.
2. **Map** — field-level mapping table per object: `Source field | Transformation | Target field | Rule / default | Notes`. Picklist value maps as separate tables.
3. **Cleanse** — dedupe (matching rules on email/phone/org number), normalise formats (dates ISO 8601, phones E.164, country codes ISO 3166).
4. **Load** — in **parent-before-child order**: Users → Accounts → Contacts → Products/Pricebooks → Opportunities/Cases → Activities → Files. Upsert on **External ID** (`Legacy_Id__c`, unique, external) so loads are re-runnable and relationships resolve by external id.
5. **Validate** — record counts per object (source vs target), sample field checks, relationship integrity, totals of amounts.
6. **Reconcile & sign-off** — reconciliation report signed by the business owner.

## Rules

- Disable/ bypass automation during bulk loads with a **bypass custom permission** or custom setting checked by triggers/flows — never deactivate production automation manually.
- Use Bulk API 2.0 (`sf data import bulk` / `sf data upsert bulk --external-id Legacy_Id__c`) for > 10k rows.
- Keep owners/created dates with "Set Audit Fields upon Record Creation" when required.
- Every run produces a success/error log; errors are fixed at source and re-run.
- **Rollback plan:** tag migrated records (`Migration_Batch__c`) so a batch can be deleted cleanly.
- Dry-run in a full-copy sandbox first; time it to plan the cut-over window.

## Deliverables for a migration story

Mapping spec (in the Technical Specification), load scripts (`scripts/data/{object}-upsert.sh` or anonymous Apex), sample CSV templates with headers, validation queries (SOQL counts), cut-over runbook in manual steps.
