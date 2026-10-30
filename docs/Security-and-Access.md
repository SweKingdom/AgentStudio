# Security and access

## Principles

1. **No stored credentials.** SiroccoARM never reads or stores passwords or tokens of external systems.
2. **Machine logins only.** Each external system uses this computer's own login:

   | System | Login used |
   |---|---|
   | git | The SSH key (`git@` URLs) or the credential helper (`https://` URLs) |
   | GitHub pull requests | The GitHub CLI (`gh auth login`) |
   | Salesforce | The Salesforce CLI's session for the org alias (`sf org login web`) |
   | Claude API | `ANTHROPIC_API_KEY` in `.env` |
   | Azure DevOps | `AZURE_DEVOPS_PAT` in `.env` |

3. **Secrets stay out of everything else.** They never appear in URLs, logs, activity, exports, the team file or the database. Repository URLs with embedded credentials are refused, and GitHub tokens in command output are redacted.
4. **Local by default.** The server listens on `127.0.0.1` only. In simulation nothing leaves the computer except an opted-in git push.
5. **People decide.** Approval gates, environment approvals and production opt-in per org.

## What is stored, and where

| Data | Location | In git? |
|---|---|---|
| Database: projects, work items, runs, costs, messages, users, audit log, settings, org registry | `data/arm.db` | No (`data/` is ignored) |
| Uploaded requirements PDFs | `data/uploads/` | No |
| Each project's repository and task worktrees | `data/projects/<KEY>/` | No (they have their own remotes) |
| API key and Azure DevOps token | `.env` | No (`.env` is ignored) |

Only `.env.example`, with empty values, is committed.

## Salesforce safeguards

- Orgs are registered by hand. The app passes only the alias to the CLI and never reads the CLI's saved logins.
- Production orgs are refused as targets until **Allow** is switched on for that org.
- On production, developers and QA only validate (check-only), anonymous Apex is refused, and the release deploys only after approval.
- Screenshot login links are one-time, kept in memory only, never logged, and restricted to pages inside the org.

## Users and roles

Login is **off** until the first admin is created (*Settings → Users & access → Create admin & turn on login*). That's fine while the app only listens on your own computer. Turn it on when several people share an instance.

| Role | Can |
|---|---|
| **Admin** | Everything, including users, app settings, team conventions and the org registry. |
| **Member** | Run projects: create, start, pause, approve and edit work. |
| **Viewer** | Read-only: projects, documents, code and costs. |

- Passwords are stored only as salted hashes.
- Sessions end after 12 hours without activity.
- Sign-in attempts are rate-limited per user name, and unknown users get the same answer as wrong passwords.

## Audit log

The audit log records project deletions, gate approvals, settings and price changes, org and team import changes, and sign-ins, with who did it and when. While login is off, actions are recorded as `local`; once it's on, they carry the user's name. It's in *Settings → Users & access*.
