---
title: Lightning Web Components standards
summary: Component structure, data access, events, SLDS, accessibility, Jest tests.
---
# Lightning Web Components standards

- **Structure:** `force-app/main/default/lwc/{camelCaseName}/` with `.html`, `.js`, `.js-meta.xml`, optional `.css`, and `__tests__/{name}.test.js`.
- **Data:** prefer Lightning Data Service (`lightning-record-form`, `getRecord`, `updateRecord`) over Apex. Use `@wire` with `cacheable=true` Apex for reads; imperative calls for writes, followed by `refreshApex` / `notifyRecordUpdateAvailable`.
- **Events:** child → parent with `CustomEvent` (lowercase names, no `on` prefix); cross-DOM with Lightning Message Service.
- **State:** reactive class fields; never mutate `@api` properties; getters for derived values.
- **Errors:** `reduceErrors` helper + `lightning/platformShowToastEvent`. Never swallow promise rejections.
- **UI:** SLDS classes and base components (`lightning-datatable`, `lightning-input`, `lightning-card`). No hardcoded colours — use SLDS styling hooks.
- **Accessibility:** labels on every input, `alternative-text` on icons, keyboard reachable actions, sufficient contrast.
- **Performance:** lazy-load heavy sections, debounce search input (300 ms), paginate lists.
- **Security:** no `innerHTML` with user data; Locker/LWS compliant.
- **Tests:** Jest with `@salesforce/sfdx-lwc-jest`; mock wires; cover render, user interaction, error state.
- `.js-meta.xml` exposes targets explicitly (`lightning__RecordPage`, `lightning__AppPage`, `lightningCommunity__Page`, `lightning__FlowScreen`) with `isExposed` true only when needed.
