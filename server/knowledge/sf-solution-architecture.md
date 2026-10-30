---
title: Salesforce solution architecture
summary: Declarative-vs-code decisions, data modelling, security model, governor limits, naming conventions and the technical-refinement checklist.
---
# Salesforce solution architecture

## Clicks before code — decision guide

| Need | Prefer | Use code when |
|---|---|---|
| Field defaulting / same-record updates | Before-save record-triggered Flow | Complex logic across many objects, high volume (>10k/day) |
| Related-record updates, notifications | After-save Flow | Needs callouts in-transaction-safe pattern, complex collections |
| Guided UI | Screen Flow | Rich interactivity, custom UX → LWC |
| Validation | Validation rule | Cross-object, aggregate validation → Apex trigger |
| Integration | Named Credential + External Service / Flow HTTP callout | Complex mapping, retries, bulk → Apex (Queueable + outbox) |
| Scheduled processing | Scheduled Flow | Large volumes → Batch Apex |

Never mix a record-triggered Flow and an Apex trigger doing related work on the same object/event without documenting order of execution.

## Data model

- Standard objects first (Account, Contact, Case, Opportunity, Lead, Asset, WorkOrder…). Custom objects only when no standard object fits.
- Master-detail when lifecycle and sharing are owned by the parent; lookup otherwise.
- Every object that is loaded or integrated gets an **External ID** field (`{System}_Id__c`, unique).
- API names: `Pascal_Case_With_Underscores__c`; descriptions on every field; help text for user-facing fields.
- Picklists: use restricted picklists and global value sets for shared values; always reference API values.

## Security model

- Org-wide defaults as restrictive as possible; open with role hierarchy, sharing rules, teams.
- Access via **permission sets / permission set groups**, not profiles. One permission set per capability.
- Apex classes `with sharing` by default; `inherited sharing` for utilities; `without sharing` only with a written justification.
- Enforce CRUD/FLS: `WITH USER_MODE` in SOQL / `AccessLevel.USER_MODE` in DML for user-facing logic.

## Governor limits to design for

100 SOQL / 150 DML per sync transaction · 50,000 rows queried · 10 s CPU (sync) · 6 MB heap · 100 callouts · no callouts after uncommitted DML. Design every automation for 200 records per transaction.

## Technical refinement checklist (per story)

1. Which objects/fields are touched? New ones fully specified (type, length, picklist values).
2. Which automation fires, on which event, with which entry condition?
3. Declarative or code — and why.
4. Security: which permission set grants access?
5. Integration contract (if any): endpoint, method, payload, idempotency, retry, error write-back.
6. Data: volumes, migration needs, external IDs.
7. Test approach: unit tests + manual verification per AC.
8. Deployment: pre/post manual steps, dependencies on other stories.
9. Risks: limits, order of execution, regression areas.
