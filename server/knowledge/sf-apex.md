---
title: Apex development standards
summary: Bulkification, trigger framework, error handling, security, naming, and the code-review checklist for Apex.
---
# Apex development standards

## Non-negotiables

- **Bulkify everything.** Design for 200 records. No SOQL or DML inside loops — collect Ids into `Set<Id>`, query once into `Map<Id, SObject>`, DML once on a `List`.
- **One trigger per object**, logic-less, delegating to a handler class (`{Object}TriggerHandler`) with methods per context (`beforeInsert`, `afterUpdate`…). Recursion guard via static `Set<Id>`.
- **No hardcoded Ids or URLs.** Use Custom Metadata, Custom Labels, `Schema.SObjectType.X.getRecordTypeInfosByDeveloperName()`.
- **No `System.debug`** in committed code.
- **Security:** `with sharing` by default; `WITH USER_MODE` / `AccessLevel.USER_MODE` for user-facing queries and DML; never build dynamic SOQL from user input without `String.escapeSingleQuotes` or bind variables.
- **Error handling:** catch specific exceptions; never swallow. Log through one central utility (e.g. `ErrorLogger.log(e, 'ClassName.method', context)`) that persists an error record. Re-throw `AuraHandledException` with a user-safe message from `@AuraEnabled` methods.
- **Type capitalisation:** `String`, `Integer`, `Boolean`, `Id`, `List<Account>` — never lowercase.
- **Constants** in a `{Domain}Constants` class; picklist values referenced by API name.

## Structure

| Layer | Naming | Responsibility |
|---|---|---|
| Trigger | `{Object}Trigger` | Delegates only |
| Handler | `{Object}TriggerHandler` | Routes trigger contexts |
| Service | `{Domain}Service` | Business logic, reusable from Flow (`@InvocableMethod`), LWC, batch |
| Selector | `{Object}Selector` | All SOQL for an object |
| Async | `{Purpose}Queueable` / `{Purpose}Batch` / `{Purpose}Schedulable` | Callouts, large volumes |
| Controller | `{Component}Controller` | `@AuraEnabled(cacheable=true)` reads, imperative writes |

## Async choice

`Queueable` (chaining, callouts with `Database.AllowsCallouts`) > `@future`. `Batch` for > 10k records. Platform Events for decoupled, retryable processing.

## Invocable methods (Flow ↔ Apex)

`@InvocableMethod(label='…' description='…' category='…')` with `List<Request>` in and `List<Result>` out, bulk-safe.

## Code-review checklist (score each 0/1)

Bulkified · No SOQL/DML in loops · Sharing declared · CRUD/FLS enforced · No hardcoded Ids · Errors logged, not swallowed · Null-safe (`?.`, `isEmpty()`) · Selector used for SOQL · Constants not literals · Test class exists with ≥ 90 % coverage · Meaningful names · Methods < 50 lines · ApexDoc on public methods.

## File format (SFDX source)

`force-app/main/default/classes/{Name}.cls` plus `{Name}.cls-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <status>Active</status>
</ApexClass>
```
Triggers: `force-app/main/default/triggers/{Name}.trigger` + `.trigger-meta.xml` (`<ApexTrigger>`).
