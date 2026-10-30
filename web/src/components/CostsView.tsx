import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Coins, Cpu, Database, Gauge, Hash, Timer } from "lucide-react";
import { api, type Costs } from "../lib/api";
import { useAgentLookup, useAgents, useMeta } from "../lib/queries";
import { duration, money, num, title, tokens } from "../lib/format";
import { CategoryChip, Kpi, Seg, AgentAvatar, TypeIcon } from "./ui";
import { AgentBars, MiniBar, StackedByAgent, TimelineByAgent } from "./Charts";
import { Count } from "./Count";
import { PageSkeleton } from "./Skeleton";

export default function CostsView({ projectId, projectKey }: { projectId?: string; projectKey?: string }) {
  const { data } = useQuery({
    queryKey: ["costs", projectId ?? "all"],
    queryFn: () => api.get<Costs>(`/costs${projectId ? `?projectId=${projectId}` : ""}`),
  });
  const { data: agents } = useAgents();
  const { data: meta } = useMeta();
  const lookup = useAgentLookup();
  const [usage, setUsage] = useState<"calls" | "busy" | "output">("busy");
  const [spendMode, setSpendMode] = useState<"interval" | "cumulative">("cumulative");
  if (!data) return <PageSkeleton inline />;

  const t = data.totals;
  const allInput = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const hitRate = allInput ? t.cacheReadTokens / allInput : 0;
  const itemCount = data.byItem.length;
  const orderedAgents = [...(agents ?? [])].sort(
    (a, b) => (meta?.pipelineRoles.indexOf(a.role) ?? 0) - (meta?.pipelineRoles.indexOf(b.role) ?? 0),
  );
  const maxAgentCost = Math.max(0, ...data.byAgent.map((a) => a.costUsd));

  const itemRows = data.byItem.slice(0, 30).map((it) => ({
    label: `${it.code}${projectId ? "" : ` (${it.project_key})`}`,
    values: Object.fromEntries(data.byItemAgent.filter((x) => x.item_id === it.item_id).map((x) => [x.agent_id, x.costUsd])),
  }));

  // Continuous buckets from the server (gaps included); labels adapt to the bucket size.
  const step = data.timelineStep ?? 60;
  const bucketLabel = (iso: string) => {
    const d = new Date(iso);
    if (step < 60) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (step < 3600) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (step < 86400) return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  const running: Record<string, number> = {};
  const buckets = (data.timelineBuckets ?? []).map((b) => {
    const values: Record<string, number> = {};
    for (const x of data.timeline) {
      if (x.bucket !== b) continue;
      values[x.agent_id] = x.costUsd;
    }
    if (spendMode === "cumulative") {
      // A running total is a value at the END of each bucket.
      for (const [k, v] of Object.entries(values)) running[k] = (running[k] ?? 0) + v;
      return { label: bucketLabel(new Date(new Date(b).getTime() + step * 1000).toISOString()), values: { ...running } };
    }
    return { label: bucketLabel(b), values };
  });
  // …and starts from zero when the first call was made.
  if (spendMode === "cumulative" && data.timelineBuckets?.length) buckets.unshift({ label: bucketLabel(data.timelineBuckets[0]), values: {} });
  const stepLabel = step < 60 ? `${step} s` : step < 3600 ? `${step / 60} min` : step < 86400 ? `${step / 3600} h` : "day";

  const usageRows = data.byAgent.map((a) => ({
    agent: lookup(a.agent_id),
    value: usage === "calls" ? a.calls : usage === "busy" ? a.busyMs / 1000 : a.outputTokens,
  }));

  return (
    <div className="col" style={{ gap: 14 }}>
      {t.simulatedUsd > 0 && (
        <div className="banner info small">
          {t.simulatedUsd >= t.costUsd - 1e-9 ? "All" : `${money(t.simulatedUsd)} of the`} figures below come from simulation runs — token counts and costs are realistic estimates at real model prices, not billed spend.
        </div>
      )}
      <div className="grid g5 stagger">
        <Kpi label="Total cost" icon={<Coins size={13} />} value={<Count value={t.costUsd} format={(n) => money(n)} />} accent foot={itemCount ? `${money(t.costUsd / itemCount)} avg per task` : undefined} />
        <Kpi label="Model calls" icon={<Hash size={13} />} value={<Count value={t.calls} format={(n) => num(n)} />} foot={`${num(data.byAgent.reduce((n, a) => n + a.runs, 0))} agent runs`} />
        <Kpi label="Tokens" icon={<Database size={13} />} value={<Count value={allInput + t.outputTokens} format={(n) => tokens(n)} />} foot={`${tokens(allInput)} in · ${tokens(t.outputTokens)} out`} />
        <Kpi label="Cache hit rate" icon={<Gauge size={13} />} value={<Count value={hitRate * 100} format={(n) => `${Math.round(n)}%`} />} foot="of input tokens read from prompt cache" />
        <Kpi label="Agent busy time" icon={<Timer size={13} />} value={duration(t.busyMs / 1000)} foot="sum of model time across agents" />
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><div className="card-title">Cost per agent</div><span className="card-sub">{money(t.costUsd)} total</span></div>
          <div className="card-pad"><AgentBars rows={data.byAgent.map((a) => ({ agent: lookup(a.agent_id), value: a.costUsd }))} /></div>
        </div>
        <div className="card">
          <div className="card-head">
            <div className="card-title">Usage per agent</div>
            <Seg value={usage} onChange={setUsage} options={[{ value: "busy", label: "Busy time" }, { value: "calls", label: "Calls" }, { value: "output", label: "Output tokens" }]} />
          </div>
          <div className="card-pad"><AgentBars rows={usageRows} fmt={usage === "busy" ? "duration" : usage === "calls" ? "count" : "tokens"} /></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">Cost per task, by agent</div><span className="card-sub">{itemCount > 30 ? "Top 30 tasks" : `${itemCount} tasks`} · project-level work (analysis, planning, release) is shown per agent above</span></div>
        <div className="card-pad"><StackedByAgent rows={itemRows} agents={orderedAgents} labelWidth={projectId ? 70 : 110} empty="Fills in as soon as agents start working on individual features and stories — analysis of the whole project is counted per agent above." /></div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="row" style={{ gap: 10 }}>
            <div className="card-title">Spend over time</div>
            <span className="card-sub">{spendMode === "cumulative" ? "running total" : `per ${stepLabel}`}, stacked by agent</span>
          </div>
          <Seg value={spendMode} onChange={setSpendMode} options={[{ value: "cumulative", label: "Cumulative" }, { value: "interval", label: `Per ${stepLabel}` }]} />
        </div>
        <div className="card-pad"><TimelineByAgent buckets={buckets} agents={orderedAgents} /></div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title"><Cpu size={15} /> Agent breakdown</div></div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr><th>Agent</th><th className="num">Runs</th><th className="num">Tasks</th><th className="num">Calls</th><th className="num">Input</th><th className="num">Cache read</th><th className="num">Output</th><th className="num">Busy</th><th>Share</th><th className="num">Cost</th></tr>
            </thead>
            <tbody>
              {data.byAgent.map((a) => {
                const ag = lookup(a.agent_id);
                return (
                  <tr key={a.agent_id}>
                    <td><Link to={`/agents/${a.agent_id}`} className="row"><AgentAvatar agent={ag} size={22} /> <span className="strong">{ag.name}</span> <span className="muted small">{ag.title}</span></Link></td>
                    <td className="num">{num(a.runs)}</td>
                    <td className="num">{num(a.items)}</td>
                    <td className="num">{num(a.calls)}</td>
                    <td className="num">{tokens(a.inputTokens + a.cacheWriteTokens)}</td>
                    <td className="num">{tokens(a.cacheReadTokens)}</td>
                    <td className="num">{tokens(a.outputTokens)}</td>
                    <td className="num">{duration(a.busyMs / 1000)}</td>
                    <td style={{ width: 140 }}><MiniBar value={a.costUsd} max={maxAgentCost} color={ag.color} /></td>
                    <td className="num strong">{money(a.costUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><div className="card-title">Cost per task</div></div>
          <div style={{ maxHeight: 420, overflow: "auto" }}>
            <table className="table">
              <thead><tr><th>Task</th><th>Category</th><th className="num">Pts</th><th className="num">$/pt</th><th className="num">Cost</th></tr></thead>
              <tbody>
                {data.byItem.map((it) => (
                  <tr key={it.item_id}>
                    <td>
                      <Link to={`/p/${projectKey ?? it.project_key}/board?item=${it.item_id}`} className="row" style={{ minWidth: 0 }}>
                        <TypeIcon type={it.type} /> <span className="mono small" style={{ whiteSpace: "nowrap" }}>{it.code}</span> <span className="ellipsis small" style={{ maxWidth: 220 }}>{it.title}</span>
                      </Link>
                    </td>
                    <td><CategoryChip value={it.category} small /></td>
                    <td className="num">{it.points ?? "—"}</td>
                    <td className="num">{it.points ? money(it.costUsd / it.points) : "—"}</td>
                    <td className="num strong">{money(it.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="col" style={{ gap: 14 }}>
          {!projectId && (
            <div className="card">
              <div className="card-head"><div className="card-title">Cost per project</div></div>
              <table className="table">
                <tbody>
                  {data.byProject.map((p) => (
                    <tr key={p.project_id}><td><Link to={`/p/${p.key}/costs`} className="row"><span className="code-tag">{p.key}</span> {p.name}</Link></td><td className="num">{num(p.calls)} calls</td><td className="num strong">{money(p.costUsd)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card">
            <div className="card-head"><div className="card-title">Cost per stage</div></div>
            <table className="table">
              <tbody>
                {data.byStage.map((s) => (
                  <tr key={s.stage}><td>{s.stage === "qa" ? "QA" : title(s.stage ?? "—")}</td><td className="num muted">{duration(s.busyMs / 1000)}</td><td className="num">{num(s.calls)} calls</td><td className="num strong">{money(s.costUsd)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <div className="card-head"><div className="card-title">Cost per model</div></div>
            <table className="table">
              <tbody>
                {data.byModel.map((m) => (
                  <tr key={m.model}><td className="mono small">{m.model}</td><td className="num">{num(m.calls)} calls</td><td className="num strong">{money(m.costUsd)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
