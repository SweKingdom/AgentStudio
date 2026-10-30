# Architecture

## Overview

```
 Browser (React SPA)                         Server (Node.js · Express 5 · 127.0.0.1:4100)
 ┌──────────────────────┐   REST /api/*      ┌────────────────────────────────────────────────┐
 │ Pages, board, charts │ ─────────────────▶ │ api.ts + routes/*   (validation, audit)        │
 │ react-query cache    │ ◀───────────────── │ orchestrator.ts     (pipeline, gates, lanes)    │
 │                      │   SSE /api/events  │ agents/runner.ts    (live loop) ─▶ Claude API   │
 └──────────────────────┘ ◀───────────────── │ agents/simulator.ts (scripted turns)           │
                                             │ agents/tools.ts     (28 tools, shared by both)  │
                                             │ git.ts · github.ts  ─▶ git / gh CLI             │
                                             │ sf.ts · screenshots ─▶ Salesforce CLI / Chrome  │
                                             │ ado.ts              ─▶ Azure DevOps REST        │
                                             │ db.ts               ─▶ SQLite (data/arm.db)     │
                                             └────────────────────────────────────────────────┘
```

- **Single process:** the server serves the API and the built web app (`web/dist`).
- **Live updates:** the server pushes events (project, item, run, message, cost, question, agent) over Server-Sent Events; the web app invalidates the matching queries.
- **Simulation and live share everything** except the source of each agent turn. Both go through the same tool handlers, so the backlog, files, git history, graph, timing and costs behave the same.

## Stack

| Layer | Technology |
|---|---|
| Server | Node.js ≥ 22.5, TypeScript run by `tsx`, Express 5, `node:sqlite` |
| AI | `@anthropic-ai/sdk`: beta Messages streaming, adaptive thinking, effort, prompt caching, eager tool-input streaming |
| PDF | `unpdf` (local text extraction for simulation and the estimate) |
| Screenshots | `playwright-core` driving the locally installed Chrome |
| Web | React 19, Vite, react-router 7, TanStack Query, Recharts, React Flow (`@xyflow/react`), lucide icons |
| Tests | `node:test` via `tsx`, with stand-ins for Claude, the Salesforce CLI, the GitHub CLI and Azure DevOps |

## Repository layout

| Path | Contents |
|---|---|
| `server/src/index.ts`, `app.ts` | Entry point and Express app (static web app, API, SPA fallback). |
| `server/src/api.ts`, `routes/` | REST endpoints. Feature routers: `ado`, `auth`, `accuracy`, `templates`. |
| `server/src/orchestrator.ts` | The pipeline: stages, gates, parallel lanes, rework loop, environments, pause and resume, time tracking. |
| `server/src/agents/roles.ts` | The seven role definitions: prompts, default model, effort, tools, knowledge, name stories. |
| `server/src/agents/runner.ts` | The live agent loop: request building, caching, cost recording, budget checks, consultations. |
| `server/src/agents/simulator.ts`, `simplan.ts` | Simulation: PDF → requirements → backlog plan, scripted turns, templated SFDX output. |
| `server/src/agents/tools.ts` | The tools agents call (work items, documents, files, tests, evidence, reviews, Salesforce, release). |
| `server/src/agents/context.ts` | What each agent receives in its first message (story card, hand-over, changed files). |
| `server/src/git.ts`, `github.ts`, `pullrequests.ts`, `review.ts` | Worktrees, merges, push, pull requests, architect code review. |
| `server/src/sf.ts`, `salesforce.ts`, `environments.ts`, `screenshots.ts`, `evidence.ts` | Salesforce CLI bridge, org registry, environment chain, real and drawn evidence. |
| `server/src/estimate.ts`, `accuracy.ts`, `pricing.ts` | Estimate, estimate vs actual, model prices. |
| `server/src/pause.ts` | Spend limits and mapping of Claude API errors to pauses. |
| `server/src/team.ts`, `templates.ts` | Conventions, Salesforce defaults, team export/import. |
| `server/src/auth.ts` | Users, sessions, roles, audit log. |
| `server/src/ado.ts` | Azure DevOps sync. |
| `server/src/doctor.ts`, `scripts/doctor.ts` | System check (`npm run doctor`). |
| `server/knowledge/` | Built-in knowledge packs (Markdown). |
| `server/test/` | Unit and end-to-end tests, fixtures and CLI stand-ins. |
| `web/src/App.tsx` | Shell: sidebar, top bar (mode badge, total spend), routes. |
| `web/src/pages/`, `pages/project/` | Pages and the per-project tabs. |
| `web/src/components/` | Charts, network graph, path bar, settings panels, shared UI. |
| `web/public/guide/` | Screenshots for the in-app Guide. |
| `docs/` | This wiki. |

## Data model

SQLite tables in `data/arm.db`:

| Area | Tables |
|---|---|
| Configuration | `settings`, `agents`, `agent_versions`, `users`, `sessions`, `audit` |
| Projects | `projects`, `work_items`, `item_phases`, `questions`, `comments`, `test_results`, `releases` |
| Content | `documents`, `files`, `file_versions` |
| Execution | `runs`, `llm_calls`, `messages`, `activity`, `chats` |

Every model call is a row in `llm_calls` (tokens, cost, duration, model, agent, item, stage, simulated or not). Every cost figure in the app is derived from it.

## The live agent loop

For each agent run (`runner.ts`):

1. **System prompt:** role instructions, knowledge packs and custom knowledge, with a cache breakpoint.
2. **First message:** the PDF (for the analyst), the shared project block with its own cache breakpoint, then the run-specific context and task.
3. **Turn loop** up to the agent's max turns: check budget and spend limits → stream a request (adaptive thinking, the agent's effort, tools with eager input streaming, optional refusal fallback) → record usage and cost → execute tool calls → feed results back.
4. **Errors:** the SDK retries transient errors 4 times; API errors are then mapped to pauses (`pause.ts`).

## The orchestrator

`orchestrator.ts` runs the stages in order. It stops at gates and runs build lanes in parallel (one story per lane: develop → QA ⇄ rework → optional code review → document → merge). It walks the environment chain on release, records phases for the timing view, and resumes interrupted steps after a pause.
