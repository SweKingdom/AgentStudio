---
title: SOQL standards
summary: Selective queries, relationship queries, limits, security clauses.
---
# SOQL standards

- Query only the fields you use. Never `SELECT` everything "just in case".
- **Selective filters** on indexed fields (Id, Name, OwnerId, CreatedDate, SystemModstamp, lookups, External Ids, unique fields) for large objects; avoid leading wildcards (`LIKE '%x'`) and negative filters (`!=`, `NOT IN`) as the only filter.
- Use bind variables (`:ids`) — never string concatenation of user input.
- Relationship queries instead of multiple queries: parent `Account.Name`, child sub-query `(SELECT Id FROM Contacts)`.
- `LIMIT` on queries that should return one row; `FOR UPDATE` only when locking is needed.
- Aggregates (`COUNT()`, `SUM()`, `GROUP BY`) instead of looping to count.
- Security: `WITH USER_MODE` for user-context queries.
- Put each object's queries in a `{Object}Selector` class.
- Large volumes (> 50k rows): Batch Apex `QueryLocator` or `Database.getCursor`.
