# Glossary

| Term | Meaning |
|---|---|
| **ARM** | Agent Relationship Management: managing a team of AI agents the way a CRM manages customers. |
| **Epic · Feature · Story · Task · Bug** | The work item hierarchy, as in Azure DevOps. Numbered sections of the requirements become epics and features; each requirement becomes a story. |
| **Acceptance criterion (AC)** | A testable condition of a story ("AC 1: …"). QA records one verdict per AC. |
| **Story points** | Relative size of a story, set from its type plus modifiers, at most 8. |
| **MoSCoW** | Must, Should, Could, Won't: the priority class the planner gives each story. |
| **WSJF** | Weighted Shortest Job First: cost of delay divided by size, used to rank the backlog. |
| **Sprint** | A planned iteration; synced to Azure DevOps iterations. |
| **Gate** | A point where the pipeline waits for a person's approval. |
| **Environment approval** | A gate before the release reaches a stage or production environment. |
| **Lane** | One story being built, tested and documented. Several lanes run in parallel. |
| **Rework loop** | QA or code review sends a story back to the developer. Counted per item and limited per project. |
| **Rudolf method** | The QA method: the ticket is the only source, one verdict per check, evidence required. |
| **Check-only deploy (validation)** | A deployment that compiles and runs tests in the org without saving anything. |
| **Quick deploy** | Deploying an already-validated release without running the tests again; used for production after approval. |
| **Smoke test** | A short check after deployment that the critical path still works. |
| **Worktree** | A separate working folder for one branch of the same git repository, so parallel lanes never collide. |
| **Draft pull request** | A PR that's visible for review but not ready to merge; each story's PR starts as one. |
| **Effort** | How hard a model thinks before answering. More effort: better reasoning, more output tokens. |
| **Prompt caching** | Re-using the unchanged start of a prompt between calls at a fraction of the input price. |
| **Simulation / Live** | A free scripted run without Claude or Salesforce, or real calls with real cost. |
| **Org alias** | The short name of a Salesforce org registered in the app and in the Salesforce CLI. |

## External references

- [Salesforce CLI command reference](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_unified.htm)
- [Salesforce DX Developer Guide](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_intro.htm)
- [Metadata API: deploying a recent validation](https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_deployRecentValidation.htm)
- [GitHub CLI manual](https://cli.github.com/manual/)
- [Azure DevOps personal access tokens](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)
- [Azure Boards: import work items from CSV](https://learn.microsoft.com/en-us/azure/devops/boards/queries/import-work-items-from-csv)
- [Azure DevOps: publish a Git repository to a wiki](https://learn.microsoft.com/en-us/azure/devops/project/wiki/publish-repo-to-wiki)
- [Claude models overview](https://docs.claude.com/en/docs/about-claude/models/overview) · [pricing](https://docs.claude.com/en/docs/about-claude/pricing) · [prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [git worktree](https://git-scm.com/docs/git-worktree)
