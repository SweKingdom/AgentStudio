# Configuration reference

## Environment variables (`.env`)

Copy `.env.example` to `.env`. The file is read when the server starts, so restart after changing it. Variables already set in the shell take precedence. `.env` is git-ignored.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Claude API key. Without it the app runs in simulation, even if Live is selected. |
| `ANTHROPIC_AUTH_TOKEN` | – | Alternative to the API key (bearer token). |
| `AZURE_DEVOPS_PAT` | – | Personal access token with Work Items read & write. Only for *Sync to Azure DevOps*. |
| `PORT` | `4100` | Port of the server. It always listens on `127.0.0.1`. |
| `ARM_DATA_DIR` | `./data` | Where the database, uploads and project repositories live. |
| `ARM_GH_BIN` | `gh` | Path to the GitHub CLI. |
| `ARM_CHROME_PATH` | auto-detected | Chrome or Chromium binary for real screenshots. |
| `HTTPS_PROXY` | – | Honoured by git and the Claude SDK. The system check notes when it's set. |

Test-only switches (`ARM_DISABLE_DOTENV`, `ARM_FORCE_GITHUB`) are set by the test setup; don't use them in normal runs.

## Application settings

Stored in the database and edited in **Settings**. Each section has its own address (`/settings/<section>`).

| Section | Settings |
|---|---|
| **General** | Mode (Simulation / Live); simulation speed; refusal fallback (lets the Claude API answer a declined request with a fallback model; Opus, Sonnet and Fable only); daily and monthly spend limits (USD, 0 = none) with auto-resume. |
| **System check** | Read-only readiness check. *Full check* also tests GitHub and access to each agent's model. |
| **Team** | Conventions, checks, export & import the team. See [The agent team](The-Agent-Team.md#team-settings). |
| **Projects** | Defaults for new projects (gates, parallel lanes, budget, max QA rework); the human-team baseline (hours per story point, hourly rate); currency (USD or EUR, with the exchange rate). |
| **Model prices** | Price per million tokens for each model: input, output, cache read, cache write. |
| **Users & access** | Optional login, users and roles, audit log. |

### Defaults

| Setting | Default |
|---|---|
| Mode | Simulation |
| Budget per project | USD 50 |
| Daily / monthly spend limit | None |
| Parallel lanes | 2 |
| Approval gates | On |
| Max QA rework | 2 |
| Hours per story point / hourly rate | 6 h / USD 65 |
| Agent model | `claude-opus-5-5` |

## Per-project settings

*Project header → Settings*: name, context, git repository (URL, branch, push), approval gates, lanes, budget, max QA rework, architect code review, the project's checks and Azure DevOps.

## Team conventions

Defaults, editable in *Settings → Team*:

| Convention | Default |
|---|---|
| Deliverables language | English |
| Branch pattern (stories / bugs) | `feature/{code}-{slug}` / `bugfix/{code}-{slug}` |
| Commit message | `{code}: {stage} — {summary}` |
| Merge message | `Merge {branch}: {code} {title}` |
| Pull request description | Title, summary, components, tests and how to test |
| Review checklist | Bulk safety, sharing, CRUD/FLS, no hard-coded IDs or credentials, and more |
| Azure DevOps | Area path, iteration root, tags |

## Checks

| Setting | Default | Meaning |
|---|---|---|
| Commands | empty | Run in order on every story; empty = detected from `package.json` (`typecheck`, `lint`, `test`, `build`). A project's own list replaces the team's. |
| Timeout per check | 15 min | A check that runs longer is stopped and counts as failed. |

Each project can override these in its settings.
