import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileCode2, Folder, Package, GitCompare, FileText, GitCommitHorizontal, GitBranch, GitMerge, GitPullRequest, Tag } from "lucide-react";
import { api, type BranchInfo, type Commit, type FileMeta, type Project } from "../../lib/api";
import { ago } from "../../lib/format";
import { useAgentLookup } from "../../lib/queries";
import { AgentAvatar, AgentTag, Empty, Seg } from "../../components/ui";
import { useAgents } from "../../lib/queries";
import { RepoChip } from "../../components/Repo";
import { ChangeCount, FileCode, FileDiff } from "../../components/CodeBlock";
import { Field, Hint } from "../../components/Hint";
import { useItems } from "./hooks";

interface FileRow extends FileMeta { versions?: number; added?: number; removed?: number; branch?: string; unmerged?: boolean }
interface Version { version: number; agent_id: string | null; item_id: string | null; item_code: string | null; added: number; removed: number; created_at: string; bytes: number }
interface Node { name: string; path: string; children: Map<string, Node>; file?: FileRow }

function buildTree(files: FileRow[]) {
  const root: Node = { name: "", path: "", children: new Map() };
  for (const f of files) {
    let cur = root;
    const parts = f.path.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!cur.children.has(part)) cur.children.set(part, { name: part, path, children: new Map() });
      cur = cur.children.get(part)!;
      if (i === parts.length - 1) cur.file = f;
    });
  }
  return root;
}

export default function CodeView({ p }: { p: Project }) {
  const agent = useAgentLookup();
  const { data: files } = useQuery({ queryKey: ["files", p.id], queryFn: () => api.get<FileRow[]>(`/projects/${p.id}/files`) });
  const [sel, setSel] = useState<string | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set(["docs"]));
  const [mode, setMode] = useState<"changes" | "file">(() => {
    try {
      return localStorage.getItem("arm.codeMode") === "file" ? "file" : "changes";
    } catch {
      return "changes";
    }
  });
  const [version, setVersion] = useState<number | null>(null);
  const [base, setBase] = useState<number | "prev" | 0>("prev");
  const [panel, setPanel] = useState<"files" | "commits" | "branches">("files");
  const [branchFilter, setBranchFilter] = useState<string | null>(null);
  const [openCommit, setOpenCommit] = useState<string | null>(null);
  const { data: agents } = useAgents();
  // Branch → its story's pull request (projects that push to GitHub).
  const { data: items } = useItems(p.id);
  const prOf = useMemo(() => new Map((items ?? []).filter((i) => i.branch && i.pr_url).map((i) => [i.branch!, i.pr_url!])), [items]);
  const { data: git } = useQuery({ queryKey: ["git", p.id, branchFilter], queryFn: () => api.get<{ branch: string; commits: Commit[]; branches: BranchInfo[] }>(`/projects/${p.id}/git${branchFilter ? `?branch=${encodeURIComponent(branchFilter)}` : ""}`), enabled: panel !== "files" });

  const { data: versions } = useQuery({
    queryKey: ["file-versions", p.id, sel],
    queryFn: () => api.get<Version[]>(`/projects/${p.id}/file-versions?path=${encodeURIComponent(sel!)}`),
    enabled: !!sel,
  });
  const current = version ?? versions?.[0]?.version ?? null;
  const baseVersion = base === "prev" ? (current && current > 1 ? current - 1 : 0) : base;
  const fetchVersion = (v: number | null) =>
    v ? api.get<{ content: string }>(`/projects/${p.id}/file-version?path=${encodeURIComponent(sel!)}&version=${v}`) : api.get<{ content: string }>(`/projects/${p.id}/file?path=${encodeURIComponent(sel!)}`);
  const { data: after } = useQuery({ queryKey: ["file", p.id, sel, current ?? "disk"], queryFn: () => fetchVersion(current), enabled: !!sel && versions !== undefined });
  const { data: before } = useQuery({ queryKey: ["file", p.id, sel, `base-${baseVersion}`], queryFn: () => (baseVersion ? fetchVersion(baseVersion) : Promise.resolve({ content: "" })), enabled: !!sel && mode === "changes" && versions !== undefined });

  const tree = useMemo(() => buildTree(files ?? []), [files]);
  useEffect(() => {
    if (!sel && files?.length) setSel((files.find((f) => f.path.endsWith(".cls") && (f.versions ?? 0) > 1) ?? files.find((f) => f.path.endsWith(".cls")) ?? files[0]).path);
  }, [files]);
  useEffect(() => {
    setVersion(null);
    setBase("prev");
  }, [sel]);
  // The Changes / File choice is yours and sticks across files (and visits).
  useEffect(() => {
    try {
      localStorage.setItem("arm.codeMode", mode);
    } catch {
      /* private mode */
    }
  }, [mode]);

  if (files && !files.length) return <Empty icon={<FileCode2 size={20} />} title="No code yet">Developers write the project's code here — mirrored on disk under <code className="code-tag">data/projects/{p.key}/workspace</code>.</Empty>;
  const meta = files?.find((f) => f.path === sel);
  const v = versions?.find((x) => x.version === current);

  const render = (n: Node, depth: number): React.ReactNode =>
    [...n.children.values()]
      .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name))
      .map((c) =>
        c.file ? (
          <div key={c.path} className={`tree-item ${sel === c.path ? "on" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setSel(c.path)} title={c.path}>
            <FileCode2 size={13} /> <span className="ellipsis" style={{ flex: 1 }}>{c.name}</span>
            {c.file.unmerged && <Hint text={`Only on ${c.file.branch} so far — merged into the default branch when the task is done.`}><GitBranch size={11} color="var(--brand-blue)" /></Hint>}
            <ChangeCount added={c.file.added} removed={c.file.removed} />
            {(c.file.versions ?? 0) > 1 && <span className="tiny faint">v{c.file.versions}</span>}
          </div>
        ) : (
          <div key={c.path}>
            <div className="tree-item" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setClosed((s) => { const x = new Set(s); x.has(c.path) ? x.delete(c.path) : x.add(c.path); return x; })}>
              {closed.has(c.path) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <Folder size={13} color="var(--sand)" /> {c.name}
            </div>
            {!closed.has(c.path) && render(c, depth + 1)}
          </div>
        ),
      );

  return (
    <div className="grid" style={{ gridTemplateColumns: "340px minmax(0, 1fr)", alignItems: "start" }}>
      <div className="card" style={{ padding: 8, maxHeight: "calc(100vh - 300px)", overflow: "auto", position: "sticky", top: 60 }}>
        <div className="row" style={{ padding: "2px 4px 8px", gap: 8 }}>
          <Seg value={panel} onChange={setPanel} options={[{ value: "files", label: <span className="row" style={{ gap: 4 }}><Package size={12} /> Files</span> }, { value: "commits", label: <span className="row" style={{ gap: 4 }}><GitCommitHorizontal size={12} /> Commits</span> }, { value: "branches", label: <span className="row" style={{ gap: 4 }}><GitBranch size={12} /> Branches</span> }]} />
          <span className="spacer" />
          <RepoChip repo={p.repoInfo} />
        </div>
        {panel === "files" ? (
          <>
            <div className="row small muted" style={{ padding: "4px 8px 8px", gap: 6 }}>{files?.length} files · workspace</div>
            {render(tree, 0)}
          </>
        ) : panel === "branches" ? (
          <div className="col" style={{ gap: 2 }}>
            <div className="small muted" style={{ padding: "4px 8px 6px" }}>One branch per task, merged into <span className="mono">{git?.branch ?? "main"}</span> when it's done · {p.repoInfo?.push ? "pushed to origin" : "local only"}</div>
            {git?.branches.map((b) => (
              <div key={b.name} className={`tree-item ${branchFilter === b.name ? "on" : ""}`} style={{ flexDirection: "column", alignItems: "stretch", whiteSpace: "normal", padding: "6px 8px", gap: 3 }} onClick={() => { setBranchFilter(b.name); setPanel("commits"); }}>
                <div className="row" style={{ gap: 6 }}>
                  {b.merged ? <GitMerge size={13} color="var(--good)" /> : <GitBranch size={13} color={b.base ? "var(--sand)" : "var(--brand-blue)"} />}
                  <span className="mono small ellipsis" style={{ flex: 1 }}>{b.name}</span>
                  {prOf.get(b.name) && <a className="chip" href={prOf.get(b.name)} target="_blank" rel="noopener noreferrer" title="Open this branch's pull request on GitHub" onClick={(e) => e.stopPropagation()} style={{ color: "var(--brand-blue)", textDecoration: "none" }}><GitPullRequest size={11} /> PR #{prOf.get(b.name)!.match(/\/pull\/(\d+)/)?.[1] ?? "?"}</a>}
                  {b.base ? <span className="chip">default</span> : b.merged ? <span className="chip" style={{ color: "var(--good)" }}>merged</span> : b.active ? <span className="chip" style={{ color: "var(--brand-blue)" }}>in progress · {b.ahead} ahead</span> : <span className="chip">{b.ahead} ahead</span>}
                </div>
                <div className="tiny faint ellipsis" style={{ paddingLeft: 19 }}><span className="mono">{b.head}</span> · {b.subject} · {ago(b.date)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="col" style={{ gap: 2 }}>
            <div className="row small muted" style={{ padding: "4px 8px 6px", gap: 6 }}>
              {git?.commits.length ?? "…"} commits {branchFilter ? <>on <span className="mono">{branchFilter}</span> <button className="btn sm ghost" onClick={() => setBranchFilter(null)}>All branches</button></> : <>on all branches</>}
            </div>
            {git?.commits.map((c) => {
              const name = c.author.split(" (")[0];
              const a = agents?.find((x) => x.name === name);
              const added = c.files.reduce((n, f) => n + f.added, 0);
              const removed = c.files.reduce((n, f) => n + f.removed, 0);
              const isOpen = openCommit === c.hash;
              return (
                <div key={c.hash} className={`tree-item ${isOpen ? "on" : ""}`} style={{ flexDirection: "column", alignItems: "stretch", whiteSpace: "normal", padding: "6px 8px", gap: 4 }} onClick={() => setOpenCommit(isOpen ? null : c.hash)}>
                  <div className="row" style={{ gap: 6, alignItems: "flex-start" }}>
                    {a ? <AgentAvatar agent={a} size={20} /> : <GitCommitHorizontal size={14} />}
                    <span className="small" style={{ flex: 1, lineHeight: 1.35 }}>{c.subject}</span>
                  </div>
                  <div className="row tiny faint" style={{ gap: 6, paddingLeft: 26 }}>
                    <span className="mono">{c.short}</span> · {name} · {ago(c.date)} <span className="spacer" /> <ChangeCount added={added} removed={removed} />
                  </div>
                  {(c.tags.length > 0 || c.branches.length > 0) && (
                    <div className="row wrap" style={{ gap: 4, paddingLeft: 26 }}>
                      {c.branches.map((b) => <span key={b} className="chip mono" style={{ background: "var(--panel-3)" }}><GitBranch size={10} /> {b}</span>)}
                      {c.tags.map((t) => <span key={t} className="chip" style={{ background: "color-mix(in srgb, var(--brand-blue) 16%, transparent)", color: "var(--brand-blue)" }}><Tag size={10} /> {t}</span>)}
                    </div>
                  )}
                  {isOpen && (
                    <div className="col" style={{ gap: 1, paddingLeft: 22, marginTop: 2 }}>
                      {c.files.map((f) => (
                        <div key={f.path} className="tree-item" onClick={(e) => { e.stopPropagation(); setSel(f.path); setPanel("files"); setMode("changes"); }} title={f.path}>
                          <FileCode2 size={12} /> <span className="ellipsis mono tiny" style={{ flex: 1 }}>{f.path.split("/").pop()}</span> <ChangeCount added={f.added} removed={f.removed} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        {sel && (
          <div className="card-head" style={{ flexWrap: "wrap" }}>
            <div className="col" style={{ gap: 4, minWidth: 0 }}>
              <span className="mono small ellipsis">{sel}</span>
              <div className="row small muted" style={{ gap: 10 }}>
                {v?.agent_id ? <AgentTag agent={agent(v.agent_id)} /> : meta?.agent_id ? <AgentTag agent={agent(meta.agent_id)} /> : null}
                {v?.item_code && <span className="code-tag">{v.item_code}</span>}
                <span>{ago(v?.created_at ?? meta?.updated_at)}</span>
                {v && <ChangeCount added={v.added} removed={v.removed} />}
              </div>
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              {versions && versions.length > 0 && (
                <Field help="Every time an agent writes this file a new version is kept. Pick which version to show.">
                  <select className="select" style={{ height: 30, padding: "2px 8px", width: 230 }} value={current ?? ""} onChange={(e) => setVersion(Number(e.target.value))}>
                    {versions.map((x) => (
                      <option key={x.version} value={x.version}>
                        v{x.version} · {agent(x.agent_id).name}{x.item_code ? ` · ${x.item_code}` : ""} · +{x.added} −{x.removed}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {mode === "changes" && versions && versions.length > 0 && (
                <Field help="What to compare against: the version just before (default), any older version, or nothing (shows the whole file as added, like a new file).">
                  <select className="select" style={{ height: 30, padding: "2px 8px", width: 190 }} value={String(base)} onChange={(e) => setBase(e.target.value === "prev" ? "prev" : Number(e.target.value))}>
                    <option value="prev">Compare with previous</option>
                    {versions.filter((x) => current && x.version < current).map((x) => <option key={x.version} value={x.version}>Compare with v{x.version}</option>)}
                    <option value="0">Compare with empty file</option>
                  </select>
                </Field>
              )}
              <Seg
                value={mode}
                onChange={setMode}
                options={[
                  { value: "changes", label: <span className="row" style={{ gap: 4 }}><GitCompare size={12} /> Changes</span> },
                  { value: "file", label: <span className="row" style={{ gap: 4 }}><FileText size={12} /> File</span> },
                ]}
              />
            </div>
          </div>
        )}
        {after &&
          (mode === "changes" && before ? (
            <FileDiff before={before.content} after={after.content} path={sel!} maxHeight="calc(100vh - 320px)" />
          ) : (
            <FileCode content={after.content} path={sel!} maxHeight="calc(100vh - 320px)" />
          ))}
      </div>
    </div>
  );
}
