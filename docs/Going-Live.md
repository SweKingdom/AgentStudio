# Going live

Live mode uses your Claude plan or API credits and changes real repositories. Go through this list once, then start small.

## Checklist

| # | Step | How |
|---|---|---|
| 1 | **API key** | Put the key in `.env` in the project folder: `ANTHROPIC_API_KEY=<key>`. Restart the app (`npm start`). |
| 2 | **System check** | `npm run doctor` or *Settings → System check → Full check*. It confirms the key is accepted and that the account can use each agent's model. Read-only and free. |
| 3 | **Mode** | *Settings → General → Live → Save*. The badge left of Total spend turns into a red **LIVE**. Only projects created from now on run live. |
| 4 | **Spend limits** | Set daily and monthly limits in *Settings → General*, and a budget on each project. |
| 5 | **Checks** | Make sure the repository has test and build scripts in `package.json`, or set the check commands in the project settings — otherwise nothing is really tested. |
| 6 | **Agents** | Check models and effort. |
| 7 | **Repository** | *Test connection* in the project, then switch *Push to origin* on. For GitHub pull requests, run `gh auth login` once on this computer. |
| 8 | **Azure DevOps** (optional) | Add `AZURE_DEVOPS_PAT` to `.env`, restart, then *Project settings → Azure DevOps → Test*. |
| 9 | **Start small** | One short requirements document, approval gates on, a budget of about USD 5. Watch the first stories end to end. |

## What to expect

- **Cost:** compare the project's estimate with the *Costs* tab as it runs; the estimate's range is calibrated on simulated runs, so the first live projects are the real test of it. The default model is `claude-opus-5-5` (USD 4 per million input tokens, USD 20 per million output tokens).
- **Time:** live runs take real time. Parallel lanes shorten the wall-clock time; the total cost stays the same.
- **Pauses:** rate limits and overload pause the work and resume by themselves; missing credit or a rejected key pause until you act. See [Estimates, costs and limits](Estimates-Costs-and-Limits.md).

## If the first call fails

| Symptom | Fix |
|---|---|
| Badge says *Live · no API key* | The server didn't find the key. Check `.env` and restart. |
| Pause: *authentication* | The key was rejected. Check it in `.env` and restart. |
| Pause: *credits* | Add credit to the Anthropic account, then resume. |
| Error mentioning a model | The account can't use that model. Pick another one for the agent (*Agents → model*). |
| Error mentioning *fallback* or a beta | Switch off *Refusal fallback* in *Settings → General* and resume. |

## Going back to simulation

*Settings → General → Simulation*. Live projects keep their mode; new projects are simulated. To remove the key, delete the line from `.env` and restart.
