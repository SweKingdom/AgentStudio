# Azure DevOps

SiroccoARM can send a project's backlog to Azure Boards, either by syncing directly or by exporting a CSV file to import.

## Sync to Azure Boards

1. Create a personal access token with **Work Items (read & write)** and add it to `.env`:

   ```
   AZURE_DEVOPS_PAT=<token>
   ```

   Restart the app. The token is read only from `.env` and sent only in the request header.
2. **Project settings → Azure DevOps:** organization URL, project, iteration root and the state mode.
3. **Test** reads the Azure DevOps project without changing anything.
4. **Backlog tab → Sync to Azure DevOps** creates or updates every epic, feature, story, task and bug, parents first.

What is sent: title, an HTML description built from the story template, acceptance criteria, story points, tags, area and iteration paths, and the parent links. Items are updated in place on later syncs, and recreated if they were deleted in Azure DevOps. Synced items get an **Azure DevOps** chip in the item drawer that opens them.

### State mode

| Mode | Use when |
|---|---|
| **Same names** | Your process is customised with SiroccoARM's state names. |
| **Agile mapping** | The standard Agile process. States are mapped to New, Active, Resolved, Closed and Removed (cancelled items). |

If Azure DevOps refuses a state name, that item is sent with the Agile mapping and the sync result says so.

Team-wide defaults for area, iterations and tags live in **Settings → Team → Conventions**.

## CSV import (no token needed)

Project header → **Export → Azure DevOps import (CSV)** produces a file for *Boards → Work items → Import work items*. The hierarchy is kept.

## Hosting this repository in Azure Repos

The repository includes `azure-pipelines.yml`, which runs the typecheck, the tests and the web build on every push and pull request. Create a pipeline from it in Azure Pipelines. This `docs/` folder can be published as the project wiki: *Wiki → Publish code as wiki*, folder `/docs`.
