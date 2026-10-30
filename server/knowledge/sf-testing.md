---
title: Apex testing standards
summary: Test data factories, coverage targets, positive/negative/bulk tests, mocking callouts.
---
# Apex testing standards

- **Coverage:** ≥ 90 % on new/changed classes (75 % org minimum is not the goal).
- **Test data factory:** all records created through `TestDataFactory` / `{Domain}TestData` builder methods — no `new Account(...)` scattered in tests. `@TestSetup` for shared data.
- **Never `SeeAllData=true`.**
- **Three scenario types per unit:** positive (happy path), negative (invalid input / missing permission → expected exception or no-op), bulk (200 records, assert no limit exceptions).
- `Test.startTest()` / `Test.stopTest()` around the code under test (resets limits, flushes async).
- **Assertions with messages**: `Assert.areEqual(expected, actual, 'why')`; assert outcomes, not just "no exception".
- **Callouts:** `HttpCalloutMock` / `Test.setMock`; multi-request mocks for chained callouts.
- **Run as:** `System.runAs(user)` with the target permission set to verify access.
- Naming: `{ClassUnderTest}Test`, methods `should{Outcome}When{Condition}`.
- Command: `sf apex run test --class-names {Class}Test --result-format human --code-coverage --synchronous`.
