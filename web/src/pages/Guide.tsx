import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import {
  ArrowUpRight, Bot, BookOpen, CheckCircle2, Cloud, Coins, GitBranch, Info, KanbanSquare, KeyRound, Library, LifeBuoy, Lightbulb,
  ListChecks, Maximize2, Radio, Rocket, Search, Settings2, ShieldCheck, Workflow, X, type LucideIcon,
} from "lucide-react";
import { useProjects } from "../lib/queries";
import { prefersReducedMotion } from "../lib/motion";

/*
 * Guide: how SiroccoARM works, for someone who has never seen it. Screenshots live in web/public/guide (served as /guide/*.png)
 * and were captured from a throw-away instance with generic demo data. Facts follow the code and its history — when a
 * feature changes, update its section here too.
 */

// ---------------------------------------------------------------- screenshots & lightbox

/** Pixel size of each screenshot (most are full 1440×900 windows; a few are cropped). Keeps layout stable while images load. */
const SHOT_SIZE: Record<string, [number, number]> = {
  "gate-backlog": [1204, 300],
  "gate-environment": [1204, 240],
  "settings-general": [1204, 560],
  "settings-orgs": [1204, 560],
  "settings-users": [1204, 560],
  "settings-system": [1204, 690],
  login: [640, 480],
};

type ShotInfo = { name: string; caption: string; alt: string };
const LightboxContext = createContext<(s: ShotInfo) => void>(() => {});

function Shot({ name, caption, alt }: { name: string; caption: string; alt?: string }) {
  const open = useContext(LightboxContext);
  const [w, h] = SHOT_SIZE[name] ?? [1440, 900];
  const text = alt ?? caption;
  return (
    // Small crops keep their own size instead of being stretched.
    <figure className="guide-shot" style={w < 900 ? { maxWidth: w } : undefined}>
      <button type="button" className="guide-shot-btn" onClick={() => open({ name, caption, alt: text })} aria-label={`Enlarge screenshot: ${caption}`}>
        <img src={`/guide/${name}.png`} alt={text} width={w} height={h} loading="lazy" decoding="async" />
        <span className="guide-shot-zoom" aria-hidden><Maximize2 size={13} /> Enlarge</span>
      </button>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/** Full-size view of one screenshot. Esc, the close button or a click outside the image closes it; focus returns to the thumbnail. */
function Lightbox({ shot, onClose }: { shot: ShotInfo; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      // The close button is the only control inside: keep keyboard focus in the dialog.
      if (e.key === "Tab") { e.preventDefault(); closeRef.current?.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); back?.focus?.(); };
  }, [onClose]);
  // Portal: page containers animate with transforms, which would trap a fixed overlay inside them.
  return createPortal(
    <div className="guide-lightbox" role="dialog" aria-modal="true" aria-label={shot.caption} onClick={onClose}>
      <div className="guide-lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <div className="guide-lightbox-bar">
          <span className="small">{shot.caption}</span>
          <button ref={closeRef} type="button" className="btn ghost sm icon" onClick={onClose} aria-label="Close (Esc)"><X size={15} /></button>
        </div>
        <img src={`/guide/${shot.name}.png`} alt={shot.alt} />
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- small building blocks

const CALLOUT: Record<string, { label: string; icon: LucideIcon }> = {
  tip: { label: "Tip", icon: Lightbulb },
  live: { label: "Live only", icon: Radio },
  never: { label: "Never stored", icon: ShieldCheck },
  note: { label: "Good to know", icon: Info },
};

function Callout({ kind, children }: { kind: keyof typeof CALLOUT; children: ReactNode }) {
  const c = CALLOUT[kind];
  return (
    <aside className={`guide-callout ${kind}`}>
      <c.icon size={15} aria-hidden />
      <div><b>{c.label}.</b> {children}</div>
    </aside>
  );
}

function AppLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="guide-applink" to={to}>Open {children} <ArrowUpRight size={13} aria-hidden /></Link>;
}

/** Link to a tab of the most recent project; without projects it offers to create one instead. */
function ProjectLink({ tab, children }: { tab?: string; children: ReactNode }) {
  const { data: projects } = useProjects();
  const p = projects?.[0];
  if (!p) return <AppLink to="/projects/new">New project</AppLink>;
  return <AppLink to={`/p/${p.key}${tab ? `/${tab}` : ""}`}>{children} in {p.key}</AppLink>;
}

function Links({ children }: { children: ReactNode }) {
  return <div className="guide-links">{children}</div>;
}

function Kbd({ children }: { children: ReactNode }) {
  return <code className="code-tag">{children}</code>;
}

// ---------------------------------------------------------------- content

type Section = { id: string; title: string; icon: LucideIcon; intro: string; body: ReactNode };

const TEAM: [string, string, string][] = [
  ["Meiga", "Business Process & Requirements Analyst", "Project brief; epics → features → stories in the story template, with acceptance criteria, categories and open questions."],
  ["Basajaun", "Salesforce Solution Architect", "Declarative-vs-code decisions, each story's technical specification, the solution design document and (optionally) code reviews."],
  ["Mari", "Backlog & Delivery Planner", "Story points, MoSCoW, WSJF, dependencies, rank, sprints and the delivery plan."],
  ["Trasgu", "Salesforce Developer", "SFDX source per story — Apex, triggers, flows, LWC, metadata, scripts — with tests, how-to-test, manual steps and a story manifest."],
  ["Cuélebre", "QA & Peer Tester (Rudolf method)", "One ✅ / ❌ / ⛔ per acceptance criterion with evidence, a test report, and approve or send back for rework."],
  ["Xana", "Technical Writer", "A task document per story, plus the living user manual, technical overview and changelog."],
  ["Nuberu", "Release Manager", "package.xml, validation, smoke tests and versioned release notes with a rollback plan."],
];

const SECTIONS: Section[] = [
  {
    id: "what",
    title: "What SiroccoARM is",
    icon: BookOpen,
    intro: "A web app on your computer where a team of AI agents turns a requirements document into a delivered Salesforce solution: backlog, technical refinement, plan, code, peer test, documentation and release. You stay in charge — you approve at the gates, answer the questions and steer the backlog.",
    body: (
      <>
        <h3>The agent team</h3>
        <div className="guide-table-wrap">
          <table className="table guide-table">
            <thead><tr><th>Agent</th><th>Role</th><th>What it produces</th></tr></thead>
            <tbody>{TEAM.map(([n, r, w]) => <tr key={n}><td className="strong">{n}</td><td>{r}</td><td>{w}</td></tr>)}</tbody>
          </table>
        </div>
        <p>The team is these seven agents. You can tailor each one (prompt, model, effort, knowledge, tools) but not add new ones for now. Agents ask each other questions with <i>consult</i> instead of guessing, and ask <i>you</i> when a business decision is needed.</p>
        <h3>Why these names</h3>
        <p>The agents are named after figures of Iberian mythology, each chosen for what its role does. Every card on the Agents page has a <b>Why “…”?</b> box with the full story and the region it comes from.</p>
        <ul className="guide-names">
          <li><b>Meiga</b> <span className="faint">· Galicia</span> — the wise woman who reads the signs and sees what others miss, as the analyst reads between the lines of a requirements document.</li>
          <li><b>Basajaun</b> <span className="faint">· Basque Country</span> — the lord of the forest who taught people to build; the architect designs the structure everything stands on.</li>
          <li><b>Mari</b> <span className="faint">· Basque Country</span> — the goddess who rules the weather and the seasons; the planner sets the project's rhythm.</li>
          <li><b>Trasgu</b> <span className="faint">· Asturias and Cantabria</span> — the house goblin who works through the night; the developer builds story after story.</li>
          <li><b>Cuélebre</b> <span className="faint">· Asturias and Cantabria</span> — the winged serpent guarding the cave's treasure; nothing reaches a release without QA's approval. (The QA method is still called the Rudolf method.)</li>
          <li><b>Xana</b> <span className="faint">· Asturias</span> — the fountain nymphs who spin golden thread; the writer weaves the project's documents into one clear thread.</li>
          <li><b>Nuberu</b> <span className="faint">· Asturias and Galicia</span> — the lord of the clouds who decides where the weather falls; the release manager decides when the work lands in each environment.</li>
        </ul>
        <Shot name="agents-names" caption="Agents page: the seven agents, with one “Why …?” box open showing the story behind the name and its region." />
        <h3>The agent network</h3>
        <p>Every hand-off, question, answer and rework request is a message. Each project's <b>Network</b> tab draws them: <b>You</b> in the centre, the orchestrator below, the agents in a ring. Edges grow with the number of messages, dashed edges are rework, and messages in flight are animated. Click an agent or an edge count to filter the conversation on the right; click a message to see it in full.</p>
        <Shot name="network" caption="A delivered project's network: who talked to whom, with cost and calls per agent." />
        <h3>Simulation and live</h3>
        <ul>
          <li><b>Simulation</b> (the default) is free. Nothing is sent to Claude or Salesforce. The requirements PDF is read locally and turned into a real backlog; the rest of the team works through the same pipeline, tools, graph and timing, with realistic token counts priced at real model rates — so costs are estimates, not billed spend.</li>
          <li><b>Live</b>: agents call the Claude API — real tokens, real time, real cost. The mode badge in the top bar, left of <i>Total spend</i>, turns into a red <b>LIVE</b> and a red line runs across the top and bottom of the window. In simulation the same badge reads <i>Simulation</i>. If Live is selected but there's no API key, an amber “Live · no API key” badge says the app is still simulating.</li>
        </ul>
        <Callout kind="note">Projects keep the mode they were created in. A project created in simulation stays simulated even after you switch the app to Live.</Callout>
        <Shot name="overview" caption="Overview: projects, items deployed, AI spend, human-equivalent effort and live activity across all projects." />
        <Links><AppLink to="/">Overview</AppLink><ProjectLink tab="network">a project's Network tab</ProjectLink><AppLink to="/settings/general">Settings → General</AppLink></Links>
      </>
    ),
  },
  {
    id: "quick-start",
    title: "Quick start: a new project",
    icon: Rocket,
    intro: "A project starts from the customer's requirements and a git repository. Before anything runs you see what it will cost and how long it will take.",
    body: (
      <>
        <ol className="guide-steps">
          <li><b>New project</b> in the sidebar (or the + next to <i>Projects</i>).</li>
          <li><b>Requirements.</b> Drop the requirements PDF (up to 32 MB), or describe the work in <i>Context for the team</i>: each sentence with “must”, “shall” or “should” becomes a story. The project name is suggested from the file name and a short key (e.g. NFS) is generated for item codes.</li>
          <li><b>Git repository.</b> Every project needs one: an <Kbd>https://</Kbd> or <Kbd>git@</Kbd> URL without credentials, and the default branch (usually <Kbd>main</Kbd>). <b>Test connection</b> reads the repository and does a dry-run push — nothing is changed on the remote. <b>Push to origin</b> is off by default.</li>
          <li><b>Team.</b> Tick the agents to involve. The path above the cards shows which stages will run; a stage without an agent is skipped.</li>
          <li><b>Run settings.</b> Approval gates (on, or autopilot), parallel lanes (stories built at the same time — faster, same total cost), budget cap, maximum QA rework, <b>Architect code review</b> (Off, Complex stories, All stories) and where releases go: one target org, or <i>Use environments instead</i> for a Test → UAT → Production chain.</li>
          <li><b>Check the estimate</b> on the right, then <b>Create &amp; start</b> — or <i>Create without starting</i> to start later. Required fields are marked with a red <b>*</b>; until they're filled in, a <i>Still needed: …</i> line under the buttons says what's missing.</li>
        </ol>
        <Shot name="new-project" caption="New project: the requirements PDF and the git repository on the left; the live estimate on the right." />
        <h3>The up-front estimate</h3>
        <p>The estimate only appears once there are requirements — nothing is invented. A local analysis (no AI, free) finds the epics, features and stories in the document, with each story's type and points. From that it shows the expected AI cost with a likely range (× 0.6 to × 1.7), the AI wall-clock time, each agent's runs × cost per run, and a human-team comparison (effort, calendar and cost). Every formula is written under its figure.</p>
        <p><b>How this is calculated</b> opens every step with the real numbers: each story with the word that decided its type and how its points were set, the human-team formulas, tokens and prices per agent, the range and the wall-clock. <i>Show the N stories this is based on</i> lists them. Once the analyst has built the real backlog, the project's forecast is recalculated from it.</p>
        <Shot name="estimate-how" caption="“How this is calculated”: stories and points, the human-team comparison and the AI cost per agent, step by step." />
        <Shot name="new-project-team" caption="Team selection with the stage path, run settings (gates, lanes, budget, rework, code review) and the estimate's assumptions." />
        <Callout kind="tip">If the high end of the estimate is above your budget cap, a warning says the run may pause before it finishes. Raise the cap or reduce the scope.</Callout>
        <Callout kind="never">Repository URLs with a user name, password or token in them are refused. Git uses this computer's own login.</Callout>
        <Links><AppLink to="/projects/new">New project</AppLink></Links>
      </>
    ),
  },
  {
    id: "pipeline",
    title: "The pipeline",
    icon: Workflow,
    intro: "Each project runs through fixed stages. Agents hand work to each other; you approve at the gates. The path bar at the top of the project shows where it is.",
    body: (
      <>
        <h3>Stages</h3>
        <ol className="guide-steps">
          <li><b>Requirements</b> — Meiga reads the document and builds epics, features and stories with acceptance criteria and open questions.</li>
          <li><b>Backlog review</b> <span className="guide-gate">gate</span> — you review the backlog and answer open questions.</li>
          <li><b>Technical refinement</b> — Basajaun completes each story's technical specification and the solution design (per feature, in parallel).</li>
          <li><b>Prioritisation &amp; delivery plan</b> — Mari estimates, prioritises and orders the backlog into sprints.</li>
          <li><b>Approve plan</b> <span className="guide-gate">gate</span> — you check estimates, priorities and sprints.</li>
          <li><b>Build · Test · Document</b> — per story, in parallel lanes: Trasgu builds, Cuélebre peer-tests (with rework loops), Basajaun reviews the code when code review is on, Xana documents.</li>
          <li><b>Approve release</b> <span className="guide-gate">gate</span> — everything is built, tested and documented.</li>
          <li><b>Deploy · Smoke test · Release</b> — Nuberu builds the manifest, validates, smoke-tests and publishes the release. With environments this becomes one step per environment (for example <i>Validate · Production → Approve Production → Deploy · Production</i>).</li>
        </ol>
        <h3>The path bar</h3>
        <p>Each step is outlined in the colours of the agents that own it (split into bands when several share it). Hover a step to read what happens there and who is working on it now. A ✓ means done, a spinner means running, a hand means it's waiting for you, and hatched, struck-through steps are skipped (gates off).</p>
        <Shot name="project-running" caption="A running project: the path bar, the team with what each agent is doing, recent activity and the forecast." />
        <h3>Approval gates</h3>
        <p>When the pipeline reaches a gate, it stops and a banner explains what to check. <b>Approve &amp; continue</b> (or the <i>Approve: …</i> button in the header) moves on. Gates can be switched off per project (autopilot).</p>
        <Shot name="gate-backlog" caption="Backlog review gate: the project waits until you approve." />
        <p><b>Environment approvals</b> are separate from the general gates: each stage or production environment can wait for you before the release goes there. A production environment that deploys is validated check-only <i>before</i> your approval, and the already-validated release is deployed <i>after</i> it.</p>
        <Shot name="gate-environment" caption="An environment approval: the release was validated against Production and waits for your go-ahead." />
        <h3>Questions hold stories</h3>
        <p>When the analyst finds something ambiguous (“to be decided”, “approx.”…) it raises a question. A story with an open question stays in <i>Requires additional information</i> and doesn't advance — the rest of the backlog carries on. Answer it in the <b>Questions</b> tab (the badge shows how many are open). The agent that asked receives the answer, and when a story's last question is answered it moves to <i>Ready for Refinement</i>; use <b>Start work</b> on it if the pipeline has already finished.</p>
        <h3>Pause, resume and spend limits</h3>
        <ul>
          <li><b>Pause</b> a project from its header: <i>Pause after current steps</i> (recommended — nothing is lost) or <i>Stop now</i> (running steps are cancelled and run again on resume). <b>Resume</b> continues where work stopped.</li>
          <li><b>Pause all</b> in the top bar stops every project; a banner explains why and offers <b>Resume all</b>.</li>
          <li><b>Budget cap</b> per project: the pipeline pauses when the project's AI cost reaches it. <i>Raise budget 50%</i> on the banner, then resume.</li>
          <li><b>Daily and monthly spend limits</b> (Settings → General) pause everything when reached. With auto-resume on, work restarts on its own when the day or month resets; resuming by hand is refused while the limit is still reached.</li>
        </ul>
        <Callout kind="live">Claude API errors become pauses instead of failures. Rate limits and overload wait for the retry time; network, credit and authentication errors wait for you.</Callout>
        <Links><ProjectLink>the project overview</ProjectLink><ProjectLink tab="questions">Questions</ProjectLink><AppLink to="/settings/general">spend limits</AppLink></Links>
      </>
    ),
  },
  {
    id: "backlog",
    title: "Working with the backlog",
    icon: KanbanSquare,
    intro: "Epics, features, stories, tasks and bugs — the same work item model as Azure DevOps. The agents move items through the states; you steer priorities, give feedback and report defects.",
    body: (
      <>
        <h3>Board</h3>
        <p>Columns follow the pipeline: <i>Backlog</i> (New, Requires additional information, Ready for Refinement, Ready for Sprint), <i>To Do</i>, <i>In Progress</i>, <i>Peer Testing</i>, <i>Documenting</i> (Ready for UAT), <i>Release Ready</i>, <i>Releasing</i> (Smoke Testing), <i>Done</i> (Deployed) and <i>Blocked</i>.</p>
        <ul>
          <li><b>Pipeline-only moves:</b> cards move through the pipeline in order, so no step between agents is skipped. You can't drag a card past a step.</li>
          <li>Drag within a column to <b>re-prioritise</b>. Drop a card on <b>In Progress</b> to start work — the right agents run each missing step in order.</li>
          <li>Filter by category; colours on the cards follow the same legend. A held card shows its open questions.</li>
        </ul>
        <Shot name="board" caption="Board during delivery: held stories in Backlog, planned stories in To Do, Cuélebre peer-testing the stories Trasgu handed over." />
        <h3>Backlog</h3>
        <p>The hierarchy (epics → features → items) with category, state, points, MoSCoW, sprint, rank, test results and AI cost per item. With Azure DevOps configured, <b>Sync to Azure DevOps</b> sends the backlog there.</p>
        <Shot name="backlog" caption="Backlog tab: the hierarchy the analyst built, with planning and quality columns." />
        <h3>The item drawer</h3>
        <p>Click any card or row to open it. The story follows the DevOps story template — <i>User Story, Background &amp; Context, Business Rules, Dependencies, Out of Scope, Acceptance Criteria, Technical Specification, How to Test, Manual Steps, Solution Components</i> — and each section shows the Azure DevOps field it maps to.</p>
        <ul>
          <li><b>Chips:</b> state, category, points, MoSCoW, priority, sprint, rank, <b>rework count</b> (how many times QA or code review sent it back), the <b>branch</b> chip (the task's own git branch), the <b>PR</b> chip (its GitHub pull request, when the project uses them), the <b>Azure DevOps</b> chip (opens the synced work item), dependencies and the source section of the requirements.</li>
          <li><b>Tabs:</b> Story, Tests, Timing, Conversation, Files &amp; docs, Cost.</li>
          <li><b>Comments:</b> every agent that works on the item afterwards reads them. <Kbd>Ctrl/⌘ + Enter</Kbd> posts.</li>
          <li><b>Re-run with feedback</b> asks one agent (developer, QA, writer, architect or analyst) to redo its part. Developer re-runs go through peer test and documentation again.</li>
          <li><b>Split</b> moves some acceptance criteria into a new story with the same parent — for stories that grew too big.</li>
          <li><b>Start work</b>, <b>Put on hold</b>, <b>Cancel</b> and <b>Reopen</b> change the lifecycle. The state itself is moved by the agents, so it can't be edited by hand.</li>
          <li><b>Chat</b> with the agent that built the item — it answers from its real runs, costs and knowledge.</li>
        </ul>
        <Shot name="item-drawer" caption="Item drawer: story template sections, chips (branch, rework count, sprint, rank) and the item's actions." />
        <h3>Bugs and patch releases</h3>
        <p><b>Report bug</b> on a delivered story creates a Bug linked to it. The developer fixes it, QA verifies it, the writer updates the changelog and the release manager publishes a <b>patch</b> release (1.0.0 → 1.0.1).</p>
        <Links><ProjectLink tab="board">the board</ProjectLink><ProjectLink tab="backlog">the backlog</ProjectLink></Links>
      </>
    ),
  },
  {
    id: "code",
    title: "Code, branches and pull requests",
    icon: GitBranch,
    intro: "Every project's workspace is a real git repository with your URL as origin. Agents work like a disciplined team: one branch per task, one commit per run, merged when done.",
    body: (
      <>
        <ul>
          <li><b>One branch per task:</b> each story or bug gets its own branch (<Kbd>feature/US-103-…</Kbd>, <Kbd>bugfix/BG-120-…</Kbd>) and its own working copy (a git worktree), so parallel lanes never write into the same folder.</li>
          <li><b>Commits per agent run:</b> development, QA and documentation runs commit on the task branch, authored by the agent. Project-level documents stay on the default branch.</li>
          <li><b>Merge into the default branch</b> once the task is documented: the default branch is merged into the task branch first, then the task is merged with a merge commit. On conflicts in live mode the developer resolves them (the merge is refused while conflict markers remain); in simulation the task's version is kept. Merged branches stay as history.</li>
          <li><b>Releases are tagged</b> on the default branch (<Kbd>v1.0.0</Kbd>).</li>
          <li><b>Push to origin</b> (opt-in per project): task branches are pushed as agents commit, the default branch after each merge, tags after each release — with this computer's own git login.</li>
        </ul>
        <h3>GitHub pull requests</h3>
        <p>When a project pushes to a GitHub repository, each story gets a pull request: it opens as a <b>draft</b> when the developer first hands the story to QA, QA's findings are posted as comments, the architect's code review is posted as a comment too, and the PR is merged on GitHub once the story is documented. The local default branch then catches up. This uses the GitHub CLI's own login (<Kbd>gh auth login</Kbd>); if <Kbd>gh</Kbd> is missing, logged out or offline, the story is merged locally and pushed as before — work is never lost. The PR description and commit formats come from the team conventions.</p>
        <h3>The Code tab</h3>
        <ul>
          <li><b>Files:</b> the SFDX source tree. Files that exist only on an unmerged task branch are marked.</li>
          <li><b>Commits:</b> every commit with its agent and branch.</li>
          <li><b>Branches:</b> default, in progress and merged, with commits ahead and a link to the PR.</li>
          <li>For a file, pick any version and compare with the previous one, any older one or an empty file. <b>Changes</b> shows a GitHub-style diff, <b>File</b> the whole file; the choice is remembered.</li>
        </ul>
        <Shot name="code-branches" caption="Code tab: one branch per task, merged into main; on the right, the developer's change to a class as a diff." />
        <Callout kind="note">With <i>Push to origin</i> off, everything stays in the local repository under the app's data folder — nothing goes over the network.</Callout>
        <Links><ProjectLink tab="code">the Code tab</ProjectLink></Links>
      </>
    ),
  },
  {
    id: "quality",
    title: "Quality and evidence",
    icon: ListChecks,
    intro: "Cuélebre peer-tests every story against its acceptance criteria and records evidence. Optionally, Basajaun reviews the code before it's merged.",
    body: (
      <>
        <h3>The Rudolf method</h3>
        <ol className="guide-steps">
          <li><b>The ticket is the only source.</b> Checks are planned from the story's How to Test, or its acceptance criteria and technical specification. If the ticket is too unclear to test, the verdict says exactly what is missing.</li>
          <li><b>Plan</b> one or more checks per acceptance criterion, including a negative check when the criterion has a condition.</li>
          <li><b>Verdict per check</b> with fixed rules: ✅ <i>Works</i> (with evidence), ❌ <i>Broken</i> (what is wrong and where), ⛔ <i>Couldn't test</i> (not a failure of the story). A “works” without evidence becomes ⛔; a ❌ is never softened.</li>
          <li><b>Overall:</b> all ✅ → approved; any ❌ → changes requested, back to the developer with one finding per ❌. A code review against the standards runs alongside.</li>
        </ol>
        <p>Each rework loop counts toward the project's <i>Max QA rework</i>; beyond it the story is marked <b>Blocked</b> for you to review. The Tests tab of an item shows the checks per iteration and the latest <b>test report</b> (versioned, printable). Smoke tests after the release appear there too.</p>
        <Shot name="test-evidence" caption="Test report in the item drawer: a check with its steps, what was found and the evidence image." />
        <h3>Evidence</h3>
        <ul>
          <li><b>Simulation:</b> evidence is a drawing of the Salesforce record page the tester checked, with the verified fields and the outcome — and a red box around what is wrong for failures. It's labelled “simulated evidence”.</li>
          <li><b>Live with an org:</b> real screenshots. The Salesforce CLI creates a one-time login link to a page in the org, a headless Chrome on this computer opens it and takes the screenshot. That link is never logged or stored, and only pages inside the org are allowed. Without Chrome, the drawing is used instead.</li>
        </ul>
        <Callout kind="live">With an org, the developer can't hand a story over until its deployment validates, and QA can't approve until the story's Apex tests pass and changed classes meet the minimum coverage.</Callout>
        <h3>Code review by Basajaun</h3>
        <p>With <i>Architect code review</i> on (complex stories — integration, development and data migration — or all stories), Basajaun reviews the task branch's diff against the team's review checklist and the solution design after QA approves and before documentation and the merge. <i>Changes requested</i> sends the story back to the developer; QA re-tests and Basajaun reviews again. It costs one extra architect run per reviewed story.</p>
        <Links><ProjectLink tab="board">an item's Tests tab</ProjectLink><AppLink to="/settings/team">the review checklist</AppLink></Links>
      </>
    ),
  },
  {
    id: "checks",
    title: "Checks: the project's own tests",
    icon: Cloud,
    intro: "Every story is proven by the project's own commands — tests, build, typecheck, lint — not by an agent saying it works.",
    body: (
      <>
        <h3>Where the checks come from</h3>
        <ol className="guide-steps">
          <li>The project's own list (project Settings → <b>Checks</b>), if it has one.</li>
          <li>Else the team's list (Settings → Team → <b>Checks</b>).</li>
          <li>Else detected from the repository's <Kbd>package.json</Kbd>: <Kbd>typecheck</Kbd>, <Kbd>lint</Kbd>, <Kbd>test</Kbd> and <Kbd>build</Kbd> scripts, in that order.</li>
        </ol>
        <h3>When they run</h3>
        <ul>
          <li><b>Developer</b> — on the story's branch with <Kbd>run_checks</Kbd>; the story only goes to QA after a passing run.</li>
          <li><b>QA</b> — again on the story's branch; QA can only approve after a passing run.</li>
          <li><b>Release</b> — on the base branch with every story merged; the release is only published after a passing run.</li>
        </ul>
        <p>Checks run in order and stop at the first failure. The agent gets the exit code and the last lines of output, fixes the cause and runs them again.</p>
        <h3>Simulation vs live</h3>
        <p>In simulation nothing is run: every check reports as passed. In live mode the commands really run on this computer, in the project's workspace, with a timeout per check (15 minutes by default).</p>
        <Callout kind="never">Agents never weaken, skip or delete a test to make the checks pass.</Callout>
      </>
    ),
  },
  {
    id: "costs",
    title: "Costs, time and exports",
    icon: Coins,
    intro: "Every model call is recorded with its tokens and duration and priced at the model that answered. Projects compare what was estimated with what really happened.",
    body: (
      <>
        <h3>Costs tab</h3>
        <ul>
          <li><b>Estimate vs actual:</b> actual cost against the expected figure and its range, per agent and per stage, plus scope (stories, points), time and usage. It's marked <i>Final</i> once the project is done.</li>
          <li><b>Charts:</b> cost per agent and usage per agent (busy time, calls or output tokens), labelled <i>name · role</i> so everyone knows what Xana does; cost per task by agent; spend over time, cumulative or per interval.</li>
        </ul>
        <Shot name="costs-estimate" caption="Estimate vs actual: the cost bar with the expected value and range, per agent and per stage." />
        <Shot name="costs-charts" caption="Cost and usage per agent (name · role), with KPIs for cost, calls, tokens, cache hit rate and busy time." />
        <Callout kind="note">In simulation the figures are realistic estimates at real model prices, not billed spend — a banner says so. In live mode they're the token counts Claude reports.</Callout>
        <h3>Timing</h3>
        <p>Averages per phase (development, testing, documentation), lead time and first-pass yield, and a Gantt chart with one row per item and one colour per phase. It ticks every second while the project runs, with a <i>now</i> marker.</p>
        <Shot name="timing" caption="Timing: phase averages and the Gantt chart per item (analysis, architecture, planning, development, testing, code review, documentation, release)." />
        <h3>Reports and exports</h3>
        <p>Project header → <b>Export</b>:</p>
        <ul>
          <li><b>Workspace (.zip)</b> — SFDX source, manifest, scripts, all documents and both CSV files.</li>
          <li><b>Backlog (CSV for Excel)</b> — every item with all template sections, estimates, states, rework and AI cost.</li>
          <li><b>Azure DevOps import (CSV)</b> — for Boards → Work items → Import; the hierarchy is kept.</li>
          <li><b>Project report (PDF)</b> — a branded A4 report: cover, executive summary, team, backlog, quality, timing, cost, releases, questions and the living documents. <i>+ test reports</i> adds every task document and test report with screenshots. Use “Save as PDF” in the print dialog.</li>
        </ul>
        <Shot name="report-cover" caption="The project report's cover, ready to print or save as PDF." />
        <h3>Azure DevOps sync</h3>
        <p>Project settings → <b>Azure DevOps</b>: organization URL, project, iteration root and how states are sent (same names, or mapped to the Agile process). <b>Test</b> reads the project without changing anything; <b>Sync to Azure DevOps</b> on the Backlog tab creates or updates every epic, feature, story, task and bug, parents first. Synced items get an Azure DevOps chip that opens them.</p>
        <Callout kind="never">The Azure DevOps personal access token lives only in your <Kbd>.env</Kbd> as <Kbd>AZURE_DEVOPS_PAT</Kbd>; it is sent only in the request header.</Callout>
        <Links><ProjectLink tab="costs">the Costs tab</ProjectLink><ProjectLink tab="timing">Timing</ProjectLink></Links>
      </>
    ),
  },
  {
    id: "agents",
    title: "Agents and the team",
    icon: Bot,
    intro: "Every agent is configurable: its model, how hard it thinks, what it knows and which tools it may use. Every change is versioned.",
    body: (
      <>
        <h3>Editing an agent</h3>
        <ul>
          <li><b>Profile:</b> name, title, description, <b>Why this name</b> (the story shown in the agent's “Why …?” box on the Agents page — its first sentence is the region), colour and icon; disabled agents are skipped by projects.</li>
          <li><b>Model</b> (Opus, Sonnet, Haiku, Fable — prices shown per million tokens), <b>effort</b> (low → max: deeper reasoning costs more output tokens) and <b>max turns per run</b>.</li>
          <li><b>Knowledge:</b> role knowledge packs you can switch on and off (story template, DevOps workflow, Rudolf method, Salesforce standards for Apex, Flow, LWC, SOQL, testing, metadata, integration, data migration, release, docs) plus <b>custom knowledge</b> — your own Markdown, always applied and winning over the packs. Shared packs live in Agents → Knowledge library.</li>
          <li><b>Prompt and tools:</b> the core instructions and the tools the agent may call. Developer and release agents also have Salesforce settings (default target org, check-only or deploy, test level).</li>
          <li><b>Versions:</b> every change to prompt, knowledge, tools or model is a version with its runs, cost and QA rework rate. Compare any version with the current one and restore it.</li>
          <li><b>Chat</b> with the agent, <b>Reset to role defaults</b>, or switch it off for new projects with <b>Enabled</b>.</li>
        </ul>
        <Shot name="agent-editor" caption="Agent editor: profile, model and effort, usage, versions and recent runs." />
        <h3>Team settings</h3>
        <ul>
          <li><b>Team conventions:</b> deliverables language, branch, commit and merge formats, the PR description, the code review checklist and Azure DevOps area, iterations and tags.</li>
          <li><b>Salesforce defaults:</b> API version, minimum coverage, name prefix, namespace and which tests run when a story is validated. Each project can override them.</li>
          <li><b>Export &amp; import the team:</b> <i>Export</i> downloads the whole team as one JSON file (agents, custom knowledge packs, conventions, Salesforce defaults, project defaults, prices). <i>Import</i> shows a preview of what changes first. API keys, org aliases, logins, git credentials, spend limits and the mode are never included.</li>
        </ul>
        <Shot name="settings-team" caption="Team conventions and Salesforce defaults — every agent follows them, and they travel with the team export." />
        <Links><AppLink to="/agents">Agents</AppLink><AppLink to="/settings/team">Settings → Team</AppLink></Links>
      </>
    ),
  },
  {
    id: "settings",
    title: "Settings and administration",
    icon: Settings2,
    intro: "Settings are grouped into sections, each with its own address. Save appears only where a section has something to save.",
    body: (
      <>
        <div className="guide-table-wrap">
          <table className="table guide-table">
            <thead><tr><th>Section</th><th>What it holds</th></tr></thead>
            <tbody>
              <tr><td className="strong">General</td><td>Mode (Simulation / Live), simulation speed, refusal fallback, daily and monthly spend limits with auto-resume</td></tr>
              <tr><td className="strong">System check</td><td>Is this computer ready? Read-only and free</td></tr>
              <tr><td className="strong">Salesforce orgs</td><td>Registered orgs, Test, Log in, Allow production</td></tr>
              <tr><td className="strong">Team</td><td>Conventions, Salesforce defaults, export &amp; import the team</td></tr>
              <tr><td className="strong">Projects</td><td>Defaults for new projects, the human-team baseline (hours per story point, hourly rate) and currency</td></tr>
              <tr><td className="strong">Model prices</td><td>Price per million tokens for every model — used by every cost figure</td></tr>
              <tr><td className="strong">Users &amp; access</td><td>Optional login, roles and the audit log</td></tr>
            </tbody>
          </table>
        </div>
        <Shot name="settings-general" caption="Settings → General: the API key and org status, the mode switch and simulation speed." />
        <h3>System check</h3>
        <p>Checks Node.js, the data folder, git and its HTTPS login, the Salesforce CLI and each registered org, the Claude API key and the Azure DevOps token. <b>Full check</b> also tests GitHub access, every org and access to each agent's model — still read-only and free. The same check runs in a terminal with <Kbd>npm run doctor</Kbd>.</p>
        <Shot name="settings-system" caption="System check: what is ready, what is missing and how to fix it." />
        <h3>Users and access</h3>
        <p>Login is off until you create the first admin — fine while the app only listens on your computer. Once on, everyone signs in, and every important change (deleting a project, approving a gate, changing settings or the team) is recorded in the <b>audit log</b>.</p>
        <ul>
          <li><b>Admin</b> — everything, including users, app settings, team conventions and the org registry.</li>
          <li><b>Member</b> — runs projects: create, start, pause, approve and edit work.</li>
          <li><b>Viewer</b> — read-only: projects, documents, code and costs.</li>
        </ul>
        <p>Passwords are stored only as salted hashes, and sessions end after 12 hours without activity. This login doesn't affect git, Salesforce or Claude — they keep using this computer's own logins.</p>
        <Shot name="settings-users" caption="Users & access before login is turned on." />
        <Shot name="login" caption="The sign-in page once login is on." />
        <Links><AppLink to="/settings">Settings</AppLink><AppLink to="/settings/system">System check</AppLink><AppLink to="/settings/users">Users &amp; access</AppLink></Links>
      </>
    ),
  },
  {
    id: "going-live",
    title: "Going live: checklist",
    icon: KeyRound,
    intro: "Live mode spends real money and can touch real orgs and repositories. Go through this list once, then start small.",
    body: (
      <>
        <ol className="guide-checklist">
          <li><b>API key:</b> copy <Kbd>.env.example</Kbd> to <Kbd>.env</Kbd> in the project folder, set <Kbd>ANTHROPIC_API_KEY</Kbd> and restart the app.</li>
          <li><b>Mode:</b> Settings → General → <b>Live</b> → Save. The red LIVE badge appears. Projects created from now on run live.</li>
          <li><b>Budget:</b> set daily and monthly spend limits, and a budget cap on each project.</li>
          <li><b>System check:</b> run the <i>Full check</i> and fix every warning you need.</li>
          <li><b>Salesforce:</b> register the org, <b>Log in</b>, then <b>Test</b> until it says connected. For a production or Trailhead org, switch <b>Allow</b> on.</li>
          <li><b>Agents:</b> check models and effort; on the release agent choose the target org and validate or deploy; on the developer choose check-only or deploy for stories.</li>
          <li><b>Repository:</b> <b>Test connection</b> in the project, then switch <b>Push to origin</b> on. For pull requests on GitHub, run <Kbd>gh auth login</Kbd> once on this computer.</li>
          <li><b>Azure DevOps</b> (optional): add <Kbd>AZURE_DEVOPS_PAT</Kbd> to <Kbd>.env</Kbd>, restart, then Project settings → Azure DevOps → <b>Test</b>.</li>
          <li><b>Start small:</b> one project, approval gates on, and watch the first stories end to end.</li>
        </ol>
        <Callout kind="never">SiroccoARM never reads or stores passwords or tokens of external systems. The Claude key and the Azure DevOps token exist only in your <Kbd>.env</Kbd>; git uses this computer's login (SSH key or credential helper); GitHub uses the <Kbd>gh</Kbd> login; Salesforce uses the CLI's login. Secrets never appear in URLs, logs or activity.</Callout>
        <Links><AppLink to="/settings/general">Settings → General</AppLink><AppLink to="/settings/system">System check</AppLink></Links>
      </>
    ),
  },
  {
    id: "faq",
    title: "Troubleshooting and FAQ",
    icon: LifeBuoy,
    intro: "The usual suspects, and what to do about them.",
    body: (
      <div className="guide-faq">
        <details><summary>The page is blank or looks out of date after an update</summary><p>The server serves the web app it built when it started. Stop it and run <Kbd>npm start</Kbd> again (it rebuilds the web app), then reload the page.</p></details>
        <details><summary>Some stories never start</summary><p>They're held by open questions — their state is <i>Requires additional information</i>. Answer them in the project's <b>Questions</b> tab; after the last answer the story moves to Ready for Refinement. Use <b>Start work</b> if the pipeline has already finished.</p></details>
        <details><summary>The project paused on its own</summary><p>Read the banner: the project's budget cap (<i>Raise budget 50%</i>, then Resume), a daily or monthly spend limit (resumes on its own when it resets, if auto-resume is on) or, in live mode, a Claude API error such as a rate limit or missing credits.</p></details>
        <details><summary>A story is Blocked</summary><p>It reached the project's <i>Max QA rework</i>. Read the test report and the conversation, then <b>Re-run with feedback</b> for the developer, or split or change the story.</p></details>
        <details><summary>Push failed, or Test connection fails</summary><p>Check that the URL is right and that this computer's git login has write access to it: an <Kbd>https://</Kbd> URL uses the credential helper (<Kbd>gh auth login</Kbd> sets it up), a <Kbd>git@</Kbd> URL uses your SSH key. They can be different GitHub accounts. Work is never lost — it stays committed in the local repository.</p></details>
        <details><summary>No pull requests are created</summary><p>PRs are only used when the project pushes and its remote is on GitHub, and they need a logged-in GitHub CLI. Without it, stories are merged locally and pushed as before.</p></details>
        <details><summary>An org says it isn't logged in</summary><p>Settings → Salesforce orgs → <b>Log in</b>, sign in in the browser, then <b>Test</b>. The alias must match the CLI's alias. A production org also needs <b>Allow</b>.</p></details>
        <details><summary>The badge says “Live · no API key”</summary><p>Live is selected but the server didn't find <Kbd>ANTHROPIC_API_KEY</Kbd>. Add it to <Kbd>.env</Kbd> and restart; until then agents keep simulating.</p></details>
        <details><summary>There's no estimate on the New project page</summary><p>The estimate needs requirements: a PDF with text, or a description of a few sentences. A scanned PDF without text gives only a rough estimate.</p></details>
        <details><summary>Azure DevOps sync fails</summary><p>Check that <Kbd>AZURE_DEVOPS_PAT</Kbd> is in <Kbd>.env</Kbd> and can read and write work items, that the iterations exist, and the state mapping: if a state name is refused, that item is sent with the Agile mapping and the sync says so.</p></details>
      </div>
    ),
  },
  {
    id: "references",
    title: "References and glossary",
    icon: Library,
    intro: "Official documentation for the tools SiroccoARM relies on, and the words used throughout the app.",
    body: (
      <>
        <h3>Official documentation</h3>
        <ul className="guide-refs">
          <li><a href="https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_org_commands_unified.htm" target="_blank" rel="noreferrer noopener">Salesforce CLI — org commands (<Kbd>sf org login web</Kbd>, <Kbd>sf org open</Kbd>)</a></li>
          <li><a href="https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_project_commands_unified.htm" target="_blank" rel="noreferrer noopener">Salesforce CLI — project commands (<Kbd>sf project deploy start</Kbd>, <Kbd>validate</Kbd>, <Kbd>quick</Kbd>)</a></li>
          <li><a href="https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_intro.htm" target="_blank" rel="noreferrer noopener">Salesforce DX Developer Guide</a></li>
          <li><a href="https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_deployRecentValidation.htm" target="_blank" rel="noreferrer noopener">Metadata API — deploying a recent validation (quick deploy)</a></li>
          <li><a href="https://cli.github.com/manual/gh_auth_login" target="_blank" rel="noreferrer noopener">GitHub CLI — <Kbd>gh auth login</Kbd></a></li>
          <li><a href="https://cli.github.com/manual/gh_pr_create" target="_blank" rel="noreferrer noopener">GitHub CLI — <Kbd>gh pr create</Kbd></a></li>
          <li><a href="https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate" target="_blank" rel="noreferrer noopener">Azure DevOps — personal access tokens</a></li>
          <li><a href="https://learn.microsoft.com/en-us/azure/devops/boards/queries/import-work-items-from-csv" target="_blank" rel="noreferrer noopener">Azure Boards — import work items from CSV</a></li>
          <li><a href="https://docs.claude.com/en/docs/about-claude/models/overview" target="_blank" rel="noreferrer noopener">Claude — models overview</a></li>
          <li><a href="https://docs.claude.com/en/docs/about-claude/pricing" target="_blank" rel="noreferrer noopener">Claude — pricing</a></li>
          <li><a href="https://docs.claude.com/en/docs/build-with-claude/prompt-caching" target="_blank" rel="noreferrer noopener">Claude — prompt caching</a></li>
          <li><a href="https://git-scm.com/docs/git-worktree" target="_blank" rel="noreferrer noopener">git — worktree</a></li>
        </ul>
        <h3>Glossary</h3>
        <dl className="guide-glossary">
          <dt>Epic · Feature · Story · Task · Bug</dt><dd>The work item hierarchy, as in Azure DevOps. Numbered sections of the requirements become epics and features; each requirement becomes a story.</dd>
          <dt>Acceptance criterion (AC)</dt><dd>A testable condition of a story (“AC 1: …”). QA records one verdict per AC.</dd>
          <dt>Story points</dt><dd>Relative size of a story. The estimate sets them from the story's type plus modifiers (offline, real-time, signature…), at most 8.</dd>
          <dt>MoSCoW</dt><dd>Must, Should, Could, Won't — the priority class the planner gives each story.</dd>
          <dt>WSJF</dt><dd>Weighted Shortest Job First: cost of delay divided by size. The planner uses it to rank the backlog.</dd>
          <dt>Sprint</dt><dd>A planned iteration. Items are assigned to sprints and synced to Azure DevOps iterations.</dd>
          <dt>Gate</dt><dd>A point where the pipeline waits for your approval.</dd>
          <dt>Lane</dt><dd>One story being built, tested and documented. Several lanes run in parallel.</dd>
          <dt>Rework loop</dt><dd>QA or code review sends a story back to the developer. Counted on the item and limited per project.</dd>
          <dt>Check-only deploy (validation)</dt><dd>A deployment that compiles and runs tests in the org without saving anything.</dd>
          <dt>Quick deploy</dt><dd>Deploying a release that was already validated, without running the tests again — used for production after your approval.</dd>
          <dt>Smoke test</dt><dd>A short check after deployment that the critical path still works.</dd>
          <dt>Worktree</dt><dd>A separate working folder for one branch of the same git repository, so parallel lanes never collide.</dd>
          <dt>Draft pull request</dt><dd>A PR that's visible for review but not ready to merge — each story's PR starts as one.</dd>
          <dt>Effort</dt><dd>How hard a model thinks before answering. More effort: better reasoning, more output tokens.</dd>
          <dt>Prompt caching</dt><dd>Re-using the unchanged start of a prompt between calls at a fraction of the input price.</dd>
          <dt>Simulation / Live</dt><dd>Free scripted run without Claude or Salesforce, or real calls with real cost.</dd>
        </dl>
      </>
    ),
  },
];

// ---------------------------------------------------------------- page

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** The element the app scrolls in (the shell's content area), so scroll-spy and jumps follow the right container. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  return (el?.closest(".content") as HTMLElement | null) ?? null;
}

export default function Guide() {
  const { section } = useParams();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(SECTIONS[0].id);
  const [shot, setShot] = useState<ShotInfo | null>(null);
  const [index, setIndex] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const tocListRef = useRef<HTMLOListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeShot = useCallback(() => setShot(null), []);

  // Search index: each section's full text (title, steps, captions), read once from the rendered page.
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const s of SECTIONS) next[s.id] = (document.getElementById(`guide-${s.id}`)?.textContent ?? s.title).toLowerCase();
    setIndex(next);
  }, []);
  const visible = useMemo(() => {
    const w = words(q);
    if (!w.length) return SECTIONS;
    return SECTIONS.filter((s) => w.every((x) => (index[s.id] ?? s.title.toLowerCase()).includes(x)));
  }, [q, index]);
  const visibleIds = useMemo(() => new Set(visible.map((s) => s.id)), [visible]);
  useEffect(() => {
    if (q) scrollerOf(rootRef.current)?.scrollTo({ top: 0 });
  }, [q]);

  const jump = useCallback((id: string, smooth = true) => {
    const el = document.getElementById(`guide-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto", block: "start" });
    // Plain history update: a router navigation would remount (and re-animate) the page for every section.
    window.history.replaceState(window.history.state, "", `/guide/${id}`);
    setActive(id);
  }, []);

  // Deep link (/guide/costs): jump once the page is laid out. Image sizes are fixed, so the position is stable.
  useEffect(() => {
    if (section && SECTIONS.some((s) => s.id === section)) requestAnimationFrame(() => jump(section, false));
  }, [section, jump]);

  // Scroll-spy: the current section is the last one whose top has passed the top of the content area.
  useEffect(() => {
    const scroller = scrollerOf(rootRef.current);
    const target: HTMLElement | Window = scroller ?? window;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = (scroller?.getBoundingClientRect().top ?? 0) + 140;
      const shown = SECTIONS.filter((s) => visibleIds.has(s.id));
      let current = shown[0]?.id;
      for (const s of shown) {
        const el = document.getElementById(`guide-${s.id}`);
        if (el && el.getBoundingClientRect().top <= top) current = s.id;
      }
      const atEnd = scroller ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4 : false;
      if (atEnd && shown.length) current = shown[shown.length - 1].id;
      if (current) setActive(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    target.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => { target.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [visibleIds]);

  // Narrow screens: keep the active entry visible in the horizontal table of contents (without moving the page).
  useEffect(() => {
    const list = tocListRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-id="${active}"]`);
    if (!list || !item || list.scrollWidth <= list.clientWidth) return;
    const left = item.offsetLeft - list.clientWidth / 2 + item.clientWidth / 2;
    list.scrollTo({ left, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [active]);

  // "/" focuses the search box, like most documentation sites — unless you're typing somewhere else.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  return (
    <LightboxContext.Provider value={setShot}>
      <div className="page guide-page" ref={rootRef}>
        <div className="page-head">
          <div>
            <h1 className="page-title">Guide</h1>
            <div className="page-sub">How SiroccoARM works, from the first requirements PDF to a released Salesforce solution — with screenshots of every screen. Click any screenshot to enlarge it.</div>
          </div>
        </div>
        <div className="guide-layout">
          <nav className="guide-toc" aria-label="Guide contents">
            <div className="guide-search">
              <Search size={14} aria-hidden />
              <input
                ref={searchRef}
                className="input"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setQ(""); if (e.key === "Enter" && visible[0]) jump(visible[0].id); }}
                placeholder="Search the guide"
                aria-label="Search the guide"
                aria-describedby="guide-search-help"
              />
              {q && <button type="button" className="btn ghost sm icon" onClick={() => { setQ(""); searchRef.current?.focus(); }} aria-label="Clear search"><X size={13} /></button>}
            </div>
            <div className="tiny faint guide-toc-count" id="guide-search-help" aria-live="polite">
              {q ? `${visible.length} of ${SECTIONS.length} sections mention every word` : <>Filters by any words in titles, steps, captions and the glossary · press <Kbd>/</Kbd> to search</>}
            </div>
            <ol className="guide-toc-list" ref={tocListRef}>
              {visible.map((s) => (
                <li key={s.id} data-id={s.id}>
                  <a href={`/guide/${s.id}`} className={active === s.id ? "on" : ""} aria-current={active === s.id ? "true" : undefined}
                    onClick={(e) => { e.preventDefault(); jump(s.id); document.getElementById(`guide-${s.id}-h`)?.focus({ preventScroll: true }); }}>
                    <s.icon size={14} aria-hidden />
                    <span>{s.title}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <div className="guide-body">
            {!visible.length && (
              <div className="card card-pad guide-empty">
                <Search size={18} aria-hidden />
                <div>No section mentions <b>“{q}”</b>. Try another word, or <button type="button" className="btn sm" onClick={() => setQ("")}>show everything</button></div>
              </div>
            )}
            {SECTIONS.map((s, i) => (
              <section key={s.id} id={`guide-${s.id}`} className="guide-sec" aria-labelledby={`guide-${s.id}-h`} hidden={!visibleIds.has(s.id)}>
                <div className="guide-sec-head">
                  <span className="guide-sec-num" aria-hidden>{String(i + 1).padStart(2, "0")}</span>
                  <h2 id={`guide-${s.id}-h`} tabIndex={-1}><s.icon size={18} aria-hidden /> {s.title}</h2>
                </div>
                <p className="guide-intro">{s.intro}</p>
                {s.body}
              </section>
            ))}
            <div className="guide-foot tiny faint"><CheckCircle2 size={12} aria-hidden /> Screenshots come from a demo instance in simulation mode with made-up projects and orgs.</div>
          </div>
        </div>
      </div>
      {shot && <Lightbox shot={shot} onClose={closeShot} />}
    </LightboxContext.Provider>
  );
}
