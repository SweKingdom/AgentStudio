# Security and access

## Principles

1. **No stored credentials.** AgentStudio never reads or stores passwords or tokens of external systems.
2. **Machine logins only.** Each external system uses this computer's own login:

   | System | Login used |
   |---|---|
   | git | The SSH key (`git@` URLs) or the credential helper (`https://` URLs) |
   | GitHub pull requests | The GitHub CLI (`gh auth login`) |
   | Claude plan | The `claude` CLI's own login (`claude /login`) |
   | Claude API | `ANTHROPIC_API_KEY` in `.env` |
   | Azure DevOps | `AZURE_DEVOPS_PAT` in `.env` |

3. **Secrets stay out of everything else.** They never appear in URLs, logs, activity, exports, the team file or the database. Repository URLs with embedded credentials are refused, and GitHub tokens in command output are redacted.
4. **Local by default.** The server listens on `127.0.0.1` only. In simulation nothing leaves the computer except an opted-in git push.
5. **People decide.** Approval gates before the plan, the build and the release.

## What is stored, and where

| Data | Location | In git? |
|---|---|---|
| Database: projects, work items, runs, costs, messages, users, audit log, settings | `data/arm.db` | No (`data/` is ignored) |
| Uploaded requirements PDFs | `data/uploads/` | No |
| Each project's repository and task worktrees | `data/projects/<KEY>/` | No (they have their own remotes) |
| API key and Azure DevOps token | `.env` | No (`.env` is ignored) |

Only `.env.example`, with empty values, is committed.

## Check safeguards

- Checks run only in live mode, only in the project's own workspace, with a timeout per command.
- Check commands are one line each, at most 10, and are set by an admin (team) or the project's settings.
- Agents can't change the check commands; they can only run them.

## Users and roles

Login is **off** until the first admin is created (*Settings → Users & access → Create admin & turn on login*). That's fine while the app only listens on your own computer. Turn it on when several people share an instance.

| Role | Can |
|---|---|
| **Admin** | Everything, including users, app settings and team conventions. |
| **Member** | Run projects: create, start, pause, approve and edit work. |
| **Viewer** | Read-only: projects, documents, code and costs. |

- Passwords are stored only as salted hashes.
- Sessions end after 12 hours without activity.
- Sign-in attempts are rate-limited per user name, and unknown users get the same answer as wrong passwords.

## Audit log

