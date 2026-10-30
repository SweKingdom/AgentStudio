# Development

## Commands

| Command | What it does |
|---|---|
| `npm install` | Installs both workspaces (`server`, `web`). |
| `npm run dev` | Server with auto-restart on :4100 and the web app with hot reload on :5173. |
| `npm start` | Builds the web app and serves everything on :4100. |
| `npm run build` | Builds the web app into `web/dist`. |
| `npm run typecheck` | TypeScript checks for server and web. |
| `npm test` | The full test suite (about 3 minutes). |
| `npm run doctor` | The system check, in the terminal. |

Run one test file from `server/`:

```bash
node --no-warnings --import tsx --test test/pause.test.ts
```

## Tests

Every test file starts with `import "./setup.ts";`, which:

- points the app at a fresh temporary data folder;
- forces simulation and removes any API key from the environment;
- ignores `.env`.

Tests never touch real systems. External tools are replaced by stand-ins:

| System | Stand-in |
|---|---|
| Claude API | A scripted client injected with `setAnthropicClientForTests` (see `test/live.test.ts`). It calls the real tools, so the live loop, guards and cost recording are exercised. |
| Claude Agent SDK | A scripted `query` set with `setSdkQueryForTests`; nothing starts a real `claude` process (`ARM_DISABLE_SUBSCRIPTION=1` in tests). |
| GitHub CLI | A fake `gh` script selected with `ARM_GH_BIN`. |
| Git remotes | Local bare repositories through `file://` URLs. |
| Azure DevOps | A local HTTP server started inside the test. |

Coverage includes the end-to-end pipeline in simulation and live, pause and resume, all spend limits and budgets, environments, pull requests, code review, Azure DevOps sync, authentication, the estimate, team export and import, and agent versions.

## Continuous integration

| Platform | File |
|---|---|
| Azure Pipelines | `azure-pipelines.yml` |
| GitHub Actions | `.github/workflows/ci.yml` |

Both run `npm ci`, the typecheck, the tests and the web build on every push and pull request. No secrets are needed, because the tests run in simulation with stand-ins.

## Conventions

- **Language:** everything in English: UI text, code comments, documentation, test names.
- **No credentials in code or data:** use machine logins and `.env` only. Never log or print tokens, and never put secrets in URLs.
- **No personal data** in code, documentation, fixtures, commit messages or screenshots. Use neutral examples (`example/task-tracker`).
- **Every form input has a help tooltip** (`Field` in `web/src/components/Hint.tsx`); required fields use `required`.
- **Brand tokens** live in `web/src/styles.css` (`--brand-primary`, `--brand-sand`, `--brand-cream`, `--brand-blue`, `--live`). Light and dark themes use the same tokens. Animations respect `prefers-reduced-motion`.
- **Database changes:** new columns via `addColumn(...)` at the end of the migration block in `server/src/db.ts`; new tables with `CREATE TABLE IF NOT EXISTS`.
- **New REST routes:** a router in `server/src/routes/<feature>.ts` exporting `register<Feature>(api)`, registered at the end of `api.ts`.

## Common changes

| Change | Where |
|---|---|
| An agent's default prompt, model, effort or tools | `server/src/agents/roles.ts` (existing agents keep their own versioned copy; use *Reset to role defaults*) |
| A new tool for agents | `server/src/agents/tools.ts`: definition plus handler, then add it to the role's tool list |
| A knowledge pack | A Markdown file in `server/knowledge/` with `title:` and `summary:` front matter (discovered automatically), then add its id to the roles that should use it in `roles.ts` |
| A model or its price | `server/src/pricing.ts` (defaults); users can edit prices in *Settings → Model prices* |
| A pipeline stage | `server/src/orchestrator.ts` |
| A documentation page | This `docs/` folder and the in-app Guide (`web/src/pages/Guide.tsx`) |

## Screenshots

The images in `web/public/guide/` (in-app Guide) and `docs/.attachments/` (this wiki) were captured from a throwaway instance seeded with generic demo data. When the UI changes, retake them the same way and never capture a real project, org or account.
