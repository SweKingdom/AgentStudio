import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket, ShieldCheck } from "lucide-react";
import { Hint } from "../../components/Hint";
import { toast } from "../../lib/toast";
import { useItems } from "./hooks";
import { Field } from "../../components/Hint";
import { useState } from "react";
import { api, type Project, type Release, type TestResult, type WorkItem } from "../../lib/api";
import { useOpenItem } from "./hooks";
import { useAgentLookup } from "../../lib/queries";
import { money } from "../../lib/format";
import { AgentTag, CategoryChip, TestBadge, TypeIcon } from "../../components/ui";
import { dateTime } from "../../lib/format";
import { Empty, Markdown } from "../../components/ui";

export default function ReleaseView({ p }: { p: Project }) {
  const { data: releases } = useQuery({ queryKey: ["releases", p.id], queryFn: () => api.get<Release[]>(`/projects/${p.id}/releases`) });
  const { data: tests } = useQuery({ queryKey: ["tests", p.id], queryFn: () => api.get<TestResult[]>(`/projects/${p.id}/tests`) });
  const smoke = (tests ?? []).filter((t) => t.kind === "smoke");
  const qa = (tests ?? []).filter((t) => t.kind === "qa");
  const pct = (arr: TestResult[], r: string) => arr.filter((t) => t.result === r).length;
  const qc = useQueryClient();
  const { data: items } = useItems(p.id);
  const ready = (items ?? []).filter((i) => i.state === "Release Ready");

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 360px", alignItems: "start" }}>
      <div className="col" style={{ gap: 14 }}>
        {ready.length > 0 && <ReadyToRelease p={p} ready={ready} releases={releases ?? []} />}
        {releases?.length ? releases.map((r) => {
          const v = r.validation ? (JSON.parse(r.validation) as { ok: boolean; mode: string; output: string }) : null;
          return (
            <div key={r.id} className="card">
              <div className="card-head">
                <div className="card-title"><Rocket size={16} color="var(--accent)" /> Release {r.version}</div>
                <div className="row small muted" style={{ gap: 10 }}>
                  {v && <span className="pill" style={{ color: v.ok ? "var(--good)" : "var(--bad)", background: v.ok ? "rgba(62,207,142,.1)" : "rgba(242,85,90,.1)" }}>{v.ok ? "✓ checks passed" : "✗ checks failed"}</span>}
                  {dateTime(r.created_at)}
                </div>
              </div>
              <div style={{ padding: "18px 28px" }}><Markdown>{r.notes}</Markdown></div>
            </div>
          );
        }) : (
          <div className="card"><Empty icon={<Rocket size={20} />} title="No release yet">When every story is release-ready, the release manager runs the project's checks on the base branch, smoke-tests each story and publishes release notes with a git tag.</Empty></div>
        )}
      </div>
      <div className="col" style={{ gap: 14 }}>
        <div className="card card-pad col" style={{ gap: 10 }}>
          <div className="card-title">Checks</div>
          {p.checks.length ? (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{p.checks.map((c) => <li key={c.name}><span className="mono">{c.command}</span></li>)}</ul>
          ) : <div className="small muted">None found — add them in the project's Settings, or add test and build scripts to package.json.</div>}
          <div className="tiny muted">Every story passes them before QA, and the release runs them again on the base branch.</div>
        </div>
        <div className="card card-pad col" style={{ gap: 10 }}>
          <div className="card-title"><ShieldCheck size={15} /> Quality</div>
          <div className="grid g3">
            <div className="stat"><span className="v" style={{ color: "var(--good)" }}>{pct(qa, "pass")}</span><span className="l">✅ peer checks</span></div>
            <div className="stat"><span className="v" style={{ color: "var(--bad)" }}>{pct(qa, "fail")}</span><span className="l">❌ failures found</span></div>
            <div className="stat"><span className="v" style={{ color: "var(--warn)" }}>{pct(qa, "blocked")}</span><span className="l">⛔ not testable</span></div>
          </div>
          <div className="grid g3">
            <div className="stat"><span className="v">{pct(smoke, "pass")}/{smoke.length}</span><span className="l">smoke tests passed</span></div>
          </div>
        </div>
        {smoke.length > 0 && (
          <div className="card">
            <div className="card-head"><div className="card-title">Smoke tests</div></div>
            <table className="table">
              <tbody>
                {smoke.map((t) => (
                  <tr key={t.id}><td style={{ width: 24 }}>{t.result === "pass" ? "✅" : t.result === "fail" ? "❌" : "⛔"}</td><td className="mono small">{t.item_code}</td><td className="small muted">{t.notes}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function nextVersion(releases: Release[], items: WorkItem[]) {
  const last = releases[0]?.version;
  if (!last) return { version: "1.0.0", kind: "first release" };
  const [ma, mi, pa] = last.split(".").map((n) => Number(n) || 0);
  return items.every((i) => i.type === "bug") ? { version: `${ma}.${mi}.${pa + 1}`, kind: "patch — bug fixes only" } : { version: `${ma}.${mi + 1}.0`, kind: "minor — new features" };
}

function ReadyToRelease({ p, ready, releases }: { p: Project; ready: WorkItem[]; releases: Release[] }) {
  const qc = useQueryClient();
  const open = useOpenItem();
  const agent = useAgentLookup();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(ready.map((i) => i.id)));
  const selected = ready.filter((i) => picked.has(i.id));
  const next = nextVersion(releases, selected.length ? selected : ready);
  const busy = p.pipelineRunning || p.jobs.length > 0;
  const release = useMutation({
    mutationFn: () => api.post(`/projects/${p.id}/release-now`, { itemIds: selected.map((i) => i.id) }),
    onSuccess: () => { toast(`Releasing ${selected.length} item(s) as v${next.version}`); qc.invalidateQueries(); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const all = selected.length === ready.length;
  const points = selected.reduce((n, i) => n + (i.story_points ?? 0), 0);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title"><Rocket size={16} color="var(--sand)" /> Ready to release <span className="chip" style={{ background: "var(--panel-3)" }}>{ready.length}</span></div>
          <div className="card-sub">Built, peer-tested and documented. Choose what goes into this release.</div>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <Hint text={all ? "Leave everything out" : "Include everything"}>
                  <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(ready.map((i) => i.id)))} style={{ accentColor: "var(--accent)" }} aria-label="Select all" />
                </Hint>
              </th>
              <th>Item</th><th>Category</th><th className="num">Pts</th><th>Peer test</th><th className="num">Rework</th><th>Built by</th><th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {ready.map((it) => (
              <tr key={it.id} className="clickable" onClick={() => open(it.id)} style={{ opacity: picked.has(it.id) ? 1 : 0.55 }}>
                <td onClick={(e) => e.stopPropagation()}>
                  <Hint text={picked.has(it.id) ? `Leave ${it.code} out of this release — it stays Release Ready for the next one.` : `Include ${it.code} in this release.`}>
                    <input type="checkbox" checked={picked.has(it.id)} onChange={() => toggle(it.id)} style={{ accentColor: "var(--accent)" }} aria-label={`Include ${it.code}`} />
                  </Hint>
                </td>
                <td>
                  <div className="row" style={{ gap: 6, minWidth: 0 }}>
                    <TypeIcon type={it.type} /> <span className="mono small nowrap">{it.code}</span>
                    <span className="ellipsis" style={{ maxWidth: 420 }}>{it.title}</span>
                  </div>
                </td>
                <td><CategoryChip value={it.category} small /></td>
                <td className="num">{it.story_points ?? "—"}</td>
                <td><TestBadge t={it.tests} /></td>
                <td className="num" style={{ color: it.rework_count ? "var(--bad)" : undefined }}>{it.rework_count || "—"}</td>
                <td>{it.assigned_agent_id ? <AgentTag agent={agent(it.assigned_agent_id)} /> : <span className="faint">—</span>}</td>
                <td className="num small">{money(it.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-head" style={{ borderTop: "1px solid var(--line)", borderBottom: 0, flexWrap: "wrap" }}>
        <div className="small muted">
          <b style={{ color: "var(--text)" }}>{selected.length}</b> of {ready.length} selected · {points} pts · next version <b className="mono" style={{ color: "var(--text)" }}>v{next.version}</b> ({next.kind})
          {p.mode === "simulation" ? " · simulated" : ""}
        </div>
        <Hint text={busy ? "Wait until the pipeline or the running job finishes." : "The release manager runs the project's checks on the base branch, smoke-tests each selected item, publishes the release notes and tags the repository."}>
          <button className="btn primary" disabled={!selected.length || busy || release.isPending} onClick={() => release.mutate()}>
            <Rocket size={14} /> Release {selected.length} item{selected.length === 1 ? "" : "s"} as v{next.version}
          </button>
        </Hint>
      </div>
    </div>
  );
}
