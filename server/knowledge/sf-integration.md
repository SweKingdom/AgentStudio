---
title: Integration patterns
summary: Named Credentials, outbox pattern, idempotency, retries, Platform Events, error write-back.
---
# Integration patterns

- **Credentials:** Named Credential + External Credential. No endpoints or secrets in code or custom settings.
- **Outbound — transactional outbox:** the business transaction writes an `Integration_Outbox__c` record (event type, payload, status `Pending`, attempts, last error); a Queueable/scheduled dispatcher sends it, retries with exponential backoff (max N attempts), marks `Sent`/`Failed`. Guarantees no lost messages and no callout-after-DML errors.
- **Idempotency:** every outbound message carries a stable key (record Id + event type + version); inbound endpoints upsert on External Id.
- **Inbound REST:** `@RestResource(urlMapping='/v1/…')`, validate payload, return proper HTTP codes (400 invalid, 404 unknown, 409 conflict, 500 unexpected), log failures.
- **Event-driven:** Platform Events for decoupled processing; Change Data Capture for replication to external systems.
- **Error write-back:** failures are visible to business users on the source record (status + last error field) and raise an alert to the support channel.
- **Contract first:** document endpoint, method, auth, payload schema (JSON example), field mapping table, error codes, retry policy, volumes and SLAs in the Technical Specification.
- **Testing:** `HttpCalloutMock` for success, 4xx, 5xx and timeout.
