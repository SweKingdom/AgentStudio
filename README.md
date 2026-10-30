# AgentStudio

**A team of seven AI agents that delivers changes to any code repository, from the requirements to the release, with people in charge at every gate.**

AgentStudio is a web application that runs on your own computer. You give it a requirements document (or a description) and a git repository. The agents analyse it, design the solution, plan, build, test, document and release it, and you approve at the key steps. Every story has to pass the project's own checks (tests, build, typecheck, lint) before it moves on. Every hand-off, token and minute is visible.

**New here? Read [Kom igång](docs/Kom-igang.md)** (Swedish): how to install, start and use the app.

## Highlights

- **Requirements → backlog:** epics, features and stories with acceptance criteria and open questions for anything ambiguous.
- **A real delivery pipeline:** design, planning, parallel build lanes, peer test with rework loops, optional architect code review, documentation and release, with approval gates.
- **Proven by the project's own checks:** `run_checks` runs the repository's tests, build, typecheck and lint. Hand-over to QA, approval and release all need a passing run.
- **Real engineering output:** one branch and worktree per story, commits signed by each agent, GitHub pull requests and tagged releases.
- **Your Claude plan or the API:** live agents run on your own Claude subscription (`claude /login`, through the Agent SDK) or on an API key.
- **Cost under control:** an estimate before anything runs, real cost per agent, story and stage, project budgets and daily/monthly spend limits that pause the work.
- **Azure DevOps:** sync the backlog to Azure Boards, or export it as CSV.

## Quick start

Requirements: Node.js 22.5+ and git 2.25+. For live work: Claude Code logged in (`claude /login`) or an API key. Optional: GitHub CLI.

```bash
npm install
npm start               # http://localhost:4100
npm run doctor          # check this machine (read-only, free)
```

The app starts in **Simulation**: the full pipeline runs with scripted agents, nothing is sent to Claude, no checks are run and nothing is billed. Switch to Live in Settings → General.

## The team

| Agent | Role |
|---|---|
| **Meiga** | Business Process & Requirements Analyst |
| **Basajaun** | Solution Architect |
| **Mari** | Backlog & Delivery Planner |
| **Trasgu** | Software Developer |
| **Cuélebre** | QA & Peer Tester |
| **Xana** | Technical Writer |
| **Nuberu** | Release Manager |

They're named after figures of Iberian mythology. See [The agent team](docs/The-Agent-Team.md) for why.

## Documentation

The full documentation is in [`docs/`](docs/Home.md) and can be published as the project wiki in Azure DevOps (*Wiki → Publish code as wiki → folder `/docs`*). The app also has a built-in **Guide**.

| | |
|---|---|
| [Getting started](docs/Getting-Started.md) | Install, run, first project |
| [How it works](docs/How-It-Works.md) | Pipeline, gates, simulation vs live |
| [The agent team](docs/The-Agent-Team.md) | Roles, tailoring, knowledge, versions |
| [Projects and backlog](docs/Projects-and-Backlog.md) | Creating projects, board, item drawer, exports |
| [Estimates, costs and limits](docs/Estimates-Costs-and-Limits.md) | How the estimate is calculated, budgets and spend limits |
| [Git and pull requests](docs/Git-and-Pull-Requests.md) | Branch per story, merges, push, GitHub PRs |
| [Quality and code review](docs/Quality-and-Code-Review.md) | The Rudolf method, evidence, architect review |
| [Salesforce orgs and environments](docs/Salesforce-Orgs-and-Environments.md) | Org registry, production opt-in, release chain |
| [Azure DevOps](docs/Azure-DevOps.md) | Boards sync, CSV import, Azure Pipelines |
| [Going live](docs/Going-Live.md) | Checklist for the real Claude API |
| [Security and access](docs/Security-and-Access.md) | Credentials, stored data, roles, audit log |
| [Configuration reference](docs/Configuration-Reference.md) | Environment variables and settings |
| [Architecture](docs/Architecture.md) | Components, data model, agent loop |
| [Development](docs/Development.md) | Commands, tests, CI, conventions |
| [Troubleshooting](docs/Troubleshooting.md) | Common problems and fixes |
| [Glossary](docs/Glossary.md) | Terms and external references |

## Project structure

```
server/            Node.js API, orchestrator, agents, integrations, tests
  src/agents/      Roles, live loop, simulator, tools, context
  knowledge/       Built-in knowledge packs
  test/            Unit and end-to-end tests with stand-ins
web/               React app (Vite)
docs/              Documentation (Azure DevOps code wiki)
data/              Local database, uploads and project repositories (git-ignored)
```

## Development

```bash
npm run dev         # web with hot reload on :5173, API on :4100
npm run typecheck
npm test            # always in simulation, never touches external systems
```

CI runs the typecheck, the tests and the build on every push and pull request (`azure-pipelines.yml`, `.github/workflows/ci.yml`). See [Development](docs/Development.md).
