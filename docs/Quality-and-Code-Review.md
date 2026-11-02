# Quality and code review

Cuélebre peer-tests every story against its acceptance criteria and records evidence. Optionally, Basajaun reviews the code before it is merged.

## The Rudolf method

1. **The ticket is the only source.** Checks are planned from the story's *How to Test*, or from its acceptance criteria and technical specification. If the ticket is too unclear to test, the verdict says exactly what is missing.
2. **Plan** one or more checks per acceptance criterion, including a negative check when the criterion has a condition.
3. **Verdict per check**, with fixed rules:
   - ✅ **Works**, with evidence;
   - ❌ **Broken**, saying what is wrong and where;
   - ⛔ **Couldn't test**, which is not a failure of the story.

   A "works" without evidence becomes ⛔, and a ❌ is never softened.
4. **Overall:** all ✅ means approved. Any ❌ means changes requested: the story goes back to the developer with one finding per ❌. A code review against the standards runs alongside.

Each rework loop counts toward the project's *Max QA rework*. Beyond it the story is marked **Blocked** for a person to review. The item's **Tests** tab shows the checks per iteration and the latest test report (versioned and printable), plus the smoke tests after the release.


## Evidence

| Mode | Evidence |
|---|---|
| Simulation | A drawing of the app page the tester checked, with the verified fields and the outcome, and a red box around what is wrong. Labelled *simulated evidence*. |
| Live | The project's checks are the hard evidence: their results are recorded with the test report. |

## Guards in live mode

In live mode the pipeline enforces, with the project's checks (`run_checks`):

- the developer can't hand a story to QA until the checks pass on its branch;
- QA can't approve until the checks pass on its branch, and the release isn't published until they pass on the base branch.

## Architect code review

*Architect code review* is set per project:

| Setting | Reviews |
|---|---|
| Off | No stories. |
| Complex stories | Integration, development and data migration stories. |
| All stories | Every story. |

Basajaun reviews the task branch's diff against the team's review checklist and the solution design, after QA approves and before documentation and the merge. *Changes requested* sends the story back to the developer; QA re-tests and Basajaun reviews again, which counts toward the rework limit. Each review costs one extra architect run, which the estimate includes. A *Code review* phase appears in Timing, and on GitHub the review is posted on the pull request.

## Lessons learned

When a story is approved after at least one rework round (QA, code review or the checks sent it back), AgentStudio writes down what later stories should do differently in the project's **Lessons learned** document (Documents tab). The developer, QA and architect read the lessons on every later story, and QA also checks that the story follows them.

- In live mode the lessons come from one extra call with no tools, at low effort, as the QA agent. It shows in the Costs view under the stage *lessons*. At most two lessons are kept per story; a lesson that repeats an existing one, or is only about that story, is dropped. If the call fails, the story is still approved and the activity feed says so.
- In simulation the first finding becomes the lesson, without a model call.
- Each lesson ends with where it came from, such as `(US-121, qa)`. The document holds at most 20 lessons of up to 200 characters; when it is full, the oldest automatic lesson goes.
- You can edit the document or **Add lesson** yourself. Your lines get `(product owner)` and are never removed automatically.
- A story with no rework costs nothing extra. Turn the feature off with **Lessons learned** in Project settings.
