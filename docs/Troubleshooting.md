# Troubleshooting

Start with the system check: `npm run doctor`, or *Settings → System check → Full check*. Each failing line says how to fix it.

| Problem | Cause and fix |
|---|---|
| The page is blank or out of date after an update | The server serves the web app it built at start. Stop it, run `npm start` (it rebuilds), reload the page. |
| The badge says **Live · no API key** | Live is selected but the server didn't find `ANTHROPIC_API_KEY`. Add it to `.env` and restart; until then agents keep simulating. |
| A project paused on its own | Read the banner. It's the project's budget (*Raise budget 50%*, then Resume), a daily or monthly spend limit (resumes by itself when it resets if auto-resume is on), or a Claude API error such as a rate limit or missing credit. |
| Some stories never start | They're held by open questions (*Requires additional information*). Answer them in the **Questions** tab; use **Start work** if the pipeline already finished. |
| A story is **Blocked** | It reached the project's *Max QA rework*. Read the test report and the conversation, then *Re-run with feedback* for the developer, or split or change the story. |
| *Test connection* or push fails | Check the URL and that this computer's git login can write to it: `https://` uses the credential helper (`gh auth login` sets it up), `git@` uses the SSH key. Work is never lost; it stays committed locally. |
| No pull requests are created | PRs need *Push to origin* on, a GitHub remote and a logged-in GitHub CLI. Without them stories are merged locally and pushed. |
| An org says it isn't logged in | *Settings → Salesforce orgs → Log in*, sign in in the browser, then *Test*. The alias must match the CLI's alias. Production orgs also need *Allow*. |
| A production org can't be selected | Switch *Allow* on for it in *Settings → Salesforce orgs*. |
| No real screenshots in live QA | Chrome isn't installed or found. Install it or set `ARM_CHROME_PATH`. Drawn evidence is used meanwhile. |
| There's no estimate on New project | It needs requirements: a PDF with text, or a description of a few sentences. A scanned PDF gives only a rough estimate. |
| Azure DevOps sync fails | Check `AZURE_DEVOPS_PAT` in `.env` (Work Items read & write), that the iterations exist, and the state mode. Refused state names fall back to the Agile mapping. |
| Live call fails mentioning *fallback* or a beta | Switch off *Refusal fallback* in *Settings → General*. |
| Port 4100 is in use | Another instance is running. Stop it, or set `PORT` in `.env`. |

## Where to look

- **Activity** tab of a project: every agent step, hand-off and error, newest first.
- **Item drawer → Conversation:** the messages about one story.
- **Server output:** the terminal running `npm start` shows startup, the mode and unexpected errors.
