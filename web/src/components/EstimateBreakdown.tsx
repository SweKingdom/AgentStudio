import type { ReactNode } from "react";
import type { Estimate } from "../lib/api";
import { hours, money, num, tokens } from "../lib/format";
import { useAgents } from "../lib/queries";
import { AgentAvatar, Modal } from "./ui";

/** Every step behind the estimate, with the actual numbers — nothing hidden. */
export function EstimateBreakdown({ est, onClose }: { est: Estimate; onClose: () => void }) {
  const { data: agents } = useAgents();
  const b = est.breakdown;
  const h = b.human;
  const totalAgentRuns = est.agents.reduce((n, a) => n + a.costUsd, 0);
  const stories = est.detected?.stories ?? [];
  return (
    <Modal wide onClose={onClose} title="How this estimate is calculated">
      <div className="col calc" style={{ gap: 22 }}>
        <Step n={1} title="Stories and points" note={est.basis === "backlog" ? "From the backlog the analyst built; points set by the planner." : est.basis === "document" ? "A local analysis reads the requirements (no AI, free): each requirement sentence (must / should / needs…) becomes a story; its type comes from keywords; its points from the type plus modifiers." : "No requirement structure found: ~1 story per 900 characters of text, 4 points each."}>
          {stories.length > 0 && (
            <div style={{ maxHeight: 300, overflow: "auto" }}>
              <table className="table">
                <thead><tr><th>Story</th><th>Type</th><th>How the points were set</th><th className="num">Points</th><th className="num" title="Effort weight = type factor × (points ÷ 3)^0.7 — scales the developer's and QA's tokens">Weight</th></tr></thead>
                <tbody>
                  {stories.map((s, i) => (
                    <tr key={i}>
                      <td className="small">{s.title}</td>
                      <td><span className="chip" style={{ fontSize: 10.5 }}>{s.category.replace(/_/g, " ")}</span></td>
                      <td className="tiny muted">{s.pointsWhy?.join(" · ") ?? "set by the planner"}</td>
                      <td className="num strong">{s.points}</td>
                      <td className="num muted">{s.weight ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="formula">Total: <b>{num(est.stories)}</b> stories · <b>{num(est.storyPoints)}</b> points{est.detected ? ` · ${est.detected.epics} epics · ${est.detected.features} features` : ""}</div>
          {est.basis === "document" && (
            <div className="tiny muted">Base points by type: integration 8 · data migration 5 · development 5 · configuration 3 · reporting 2 · security 2 · script 2 · other 3. Modifiers: +3 if it mentions offline / real-time / signature, +2 if a story combines several requirements; maximum 8.</div>
          )}
        </Step>

        <Step n={2} title="Human team (the comparison)" note="Hours per point and the hourly rate are editable in Settings → Projects.">
          <div className="formula">Effort = {num(h.points)} points × {h.hoursPerPoint} h/point × {h.overhead} <span className="muted">(+35 % analysis, planning, documentation, release)</span> = <b>{hours(h.hours)}</b></div>
          <div className="formula">Calendar = {hours(h.hours)} ÷ ({h.teamSize} people × {h.hoursPerWeek} h/week) = <b>{h.weeks.toFixed(1)} weeks</b></div>
          <div className="formula">Cost = {hours(h.hours)} × {money(h.rate)}/h = <b>{money(h.cost, 0)}</b></div>
        </Step>

        <Step n={3} title="AI cost per agent" note={`Tokens per run come from each role's work profile; the developer's and QA's scale with the stories' average weight (${b.avgWeight}). Reasoning tokens per call depend on the agent's effort level (low 150 · medium 500 · high 1,100 · xhigh 1,800 · max 2,800). Cached tokens (system prompt, earlier turns) are billed at the cache-read price. QA rework adds ${Math.round(b.reworkRate * 100)} % more developer and QA runs.`}>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th><th className="num">Runs</th><th className="num">Calls / run</th>
                  <th className="num">Input</th><th className="num">Cache write</th><th className="num">Cache read</th><th className="num">Output</th>
                  <th className="num">$ / run</th><th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {est.agents.map((a) => {
                  const ag = agents?.find((x) => x.id === a.agentId);
                  const d = a.detail;
                  return (
                    <tr key={a.agentId}>
                      <td>
                        <div className="row" style={{ gap: 6 }}>{ag && <AgentAvatar agent={ag} size={20} />}<b>{a.name}</b></div>
                        <div className="tiny faint">{a.model.replace("claude-", "")} · effort {d.effort} · {d.basis}</div>
                      </td>
                      <td className="num">{a.runs}</td>
                      <td className="num">{d.callsPerRun}</td>
                      <TokenCell n={d.perRun.input} price={d.prices.input} />
                      <TokenCell n={d.perRun.cacheWrite} price={d.prices.cacheWrite} />
                      <TokenCell n={d.perRun.cacheRead} price={d.prices.cacheRead} />
                      <TokenCell n={d.perRun.output} price={d.prices.output} note={`incl. ${num(d.thinkingPerCall)} reasoning tokens × ${d.callsPerRun} calls`} />
                      <td className="num">{money(d.costPerRun)}</td>
                      <td className="num strong">{money(a.costUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="formula">Agent total = runs × $ per run · $ per run = Σ (tokens per run × price per million ÷ 1,000,000) → <b>{money(totalAgentRuns)}</b></div>
          <div className="formula">Requirements read: {b.pdf.pages ? `${num(b.pdf.textTokens)} text tokens + ${b.pdf.pages} pages × ${num(b.pdf.perPage)}` : `${num(b.pdf.textTokens)} text tokens`} ≈ <b>{num(est.pdfTokens)} tokens</b> {b.pdf.counted ? "(counted exactly by the Claude API)" : "(estimated; counted exactly in live mode)"}</div>
        </Step>

        <Step n={4} title="Range" note="Real runs vary with how ambiguous the requirements are, how many questions and rework loops happen, and how long the generated code is.">
          <div className="formula">Low = {money(est.totalUsd)} × {b.range.low} = <b>{money(est.lowUsd)}</b> · Expected = <b>{money(est.totalUsd)}</b> · High = {money(est.totalUsd)} × {b.range.high} = <b>{money(est.highUsd)}</b></div>
        </Step>

        <Step n={5} title="AI wall-clock time" note="Each agent's time = output tokens ÷ the model's output speed + ~3 s per call. Stages run one after another; architecture and delivery run in parallel lanes. Time waiting at approval gates isn't included.">
          <table className="table">
            <thead><tr><th>Stage</th><th className="num">Agent time</th><th className="num">In parallel</th><th className="num">Elapsed</th></tr></thead>
            <tbody>
              {b.wallClock.map((w) => (
                <tr key={w.stage}><td>{w.stage}</td><td className="num">{mins(w.agentMinutes)}</td><td className="num">÷ {w.parallel}</td><td className="num strong">{mins(w.minutes)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="formula">Total ≈ <b>{mins(est.minutes)}</b> · Faster than the human team = ({hours(h.hours)} × 60 ÷ {h.teamSize} people) ÷ {mins(est.minutes)} ≈ <b>{num(est.speedup)}×</b></div>
        </Step>
      </div>
    </Modal>
  );
}

const mins = (m: number) => (m < 90 ? `${num(m, m < 10 ? 1 : 0)} min` : hours(m / 60));

function TokenCell({ n, price, note }: { n: number; price: number; note?: string }) {
  return (
    <td className="num" title={`${num(n)} tokens × $${price}/M = ${money((n * price) / 1e6)}${note ? ` — ${note}` : ""}`}>
      {tokens(n)}
      <div className="tiny faint">${price}/M</div>
    </td>
  );
}

function Step({ n, title, note, children }: { n: number; title: string; note?: string; children: ReactNode }) {
  return (
    <section className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
        <span className="calc-n">{n}</span>
        <span className="strong">{title}</span>
      </div>
      {note && <div className="small muted" style={{ marginTop: -2 }}>{note}</div>}
      {children}
    </section>
  );
}
