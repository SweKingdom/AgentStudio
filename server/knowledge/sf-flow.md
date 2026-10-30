---
title: Flow standards
summary: Flow naming, before/after-save choice, entry criteria, fault paths, subflows and metadata layout.
---
# Flow standards

- **Naming:** `{Object}_{Trigger}_{Purpose}` for record-triggered (e.g. `Case_AfterSave_Escalate`), `SCR_{Purpose}` for screen flows, `SUB_{Purpose}` for subflows, `SCH_{Purpose}` for scheduled. Description filled on every flow and element.
- **Before-save** (Fast Field Updates) for same-record field updates — 10× faster, no DML. **After-save** for related records, emails, callouts (async path).
- **Entry criteria are mandatory** on record-triggered flows; use "only when record is updated to meet the condition" to avoid re-firing. Use `$Record__Prior` to detect changes (`ISCHANGED` in formula conditions).
- **No DML or Get Records inside loops.** Collect into collection variables, then one Create/Update after the loop.
- **Fault paths** on every DML, Get Records and Action element → log the error (invocable logger or error record) and, in screen flows, show a friendly message.
- **Subflows** for reused logic; keep each flow focused and under ~50 elements.
- **No hardcoded Ids** — Custom Metadata / Custom Labels / Get Records by DeveloperName.
- **Run context:** system context only when justified; document why.
- **Versioning:** activate via metadata `<status>Active</status>`; one active version.
- **Testing:** Flow tests or Apex tests that exercise the trigger path, covering each decision outcome.

Metadata path: `force-app/main/default/flows/{ApiName}.flow-meta.xml`. Root element `<Flow xmlns="http://soap.sforce.com/2006/04/metadata">` with `apiVersion`, `label`, `processType` (`AutoLaunchedFlow` for record-triggered, `Flow` for screen), `start` (with `object`, `recordTriggerType`, `triggerType` = `RecordBeforeSave`/`RecordAfterSave`, `filterFormula` or `filters`), and `status`.
