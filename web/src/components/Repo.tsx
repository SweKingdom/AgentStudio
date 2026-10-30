import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { GitBranch, GitCommitHorizontal, AlertTriangle, CheckCircle2, Loader2, Plug, XCircle } from "lucide-react";
import { api } from "../lib/api";
import type { RepoInfo } from "../lib/api";
import { Field, Hint } from "./Hint";
import { Switch } from "./ui";

const PROVIDER: Record<RepoInfo["provider"], string> = { github: "GitHub", azure: "Azure Repos", gitlab: "GitLab", bitbucket: "Bitbucket", other: "Git" };

/** Same rules as the server: https/ssh URL, no embedded user/password/token. */
export function repoUrlError(url: string): string | null {
  const u = url.trim();
  if (!u) return "A git repository URL is required.";
  if (/\s/.test(u)) return "The URL can't contain spaces.";
  const https = u.match(/^https?:\/\/([^/@]+@)?([^/]+)\/(.+)$/i);
  if (https) return https[1] ? "Don't put a user, password or token in the URL — SiroccoARM never stores credentials." : null;
  if (/^(ssh:\/\/)?git@[\w.-]+[:/][\w./~-]+$/i.test(u)) return null;
  if (/^file:\/\/\/\S+$/i.test(u)) return null;
  return "Use an https:// or git@ URL, e.g. https://github.com/org/repo.git";
}

export interface RepoValue { url: string; branch: string; push: boolean }

export function RepoFields({ url, branch, push, onChange }: RepoValue & { onChange: (v: RepoValue) => void }) {
  const err = url ? repoUrlError(url) : null;
  return (
    <div className="col" style={{ gap: 10 }}>
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 160px", gap: 12 }}>
      <Field
        label="Git repository"
        required
        help="The repository this project's code belongs to (GitHub, Azure Repos, GitLab…). The workspace is a real git repo with this URL as origin: each task gets its own branch (feature/US-…), every agent run is a commit on it, finished tasks are merged into the default branch and every release is tagged. No credentials are stored."
        hint={err ? <span style={{ color: "var(--bad)" }}>{err}</span> : undefined}
      >
        <input className="input mono" style={err ? { borderColor: "var(--bad)" } : undefined} value={url} onChange={(e) => onChange({ url: e.target.value, branch, push })} placeholder="https://github.com/org/repo.git" spellCheck={false} />
      </Field>
      <Field label="Default branch" help="The integration branch: task branches start from it and are merged back into it when done; releases are tagged on it. Usually main.">
        <input className="input mono" value={branch} onChange={(e) => onChange({ url, branch: e.target.value, push })} placeholder="main" spellCheck={false} />
      </Field>
    </div>
      <RepoTest url={url} />
      <Field
        label="Push to origin"
        help="When on, task branches are pushed as agents commit, and the default branch and release tags are pushed after each merge and release. It uses this computer's own git login (SSH key or credential helper) — SiroccoARM never stores or asks for credentials. Off: everything stays in the local repository."
      >
        <Switch on={push} onChange={(v) => onChange({ url, branch, push: v })} label={push ? "Push branches and tags with this computer's git login" : "Local only — nothing is pushed"} />
      </Field>
    </div>
  );
}

interface RepoTestResult { read: boolean; write: boolean; output: string; branches: string[] }

/** Can this computer read and push to the repository with its own git login? Nothing is changed on the remote. */
function RepoTest({ url }: { url: string }) {
  const [r, setR] = useState<RepoTestResult | null>(null);
  const test = useMutation({
    mutationFn: () => api.post<RepoTestResult>("/repo/test", { url: url.trim() }),
    onSuccess: setR,
    onError: (e: Error) => setR({ read: false, write: false, output: e.message, branches: [] }),
  });
  const first = (s: string) => s.split("\n").find((l) => /fatal|error|denied|not found|could not|permission/i.test(l)) ?? s.split("\n")[0];
  return (
    <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
      <Hint text="Checks with this computer's own git login (SSH key or credential helper): reads the repository and does a dry-run push. Nothing is changed on the remote and no credentials are stored.">
        <button type="button" className="btn sm" disabled={!url.trim() || !!repoUrlError(url) || test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? <Loader2 size={13} className="spin" /> : <Plug size={13} />} Test connection
        </button>
      </Hint>
      {r && (
        <div className="small" style={{ lineHeight: 1.45, minWidth: 0, color: r.read && r.write ? "var(--good)" : r.read ? "var(--warn)" : "var(--bad)" }}>
          {r.read && r.write ? (
            <span className="row" style={{ gap: 5 }}><CheckCircle2 size={13} /> Connected — can read and push{r.branches.length ? ` · branches: ${r.branches.slice(0, 6).join(", ")}${r.branches.length > 6 ? "…" : ""}` : " · empty repository"}</span>
          ) : r.read ? (
            <span className="row" style={{ gap: 5, alignItems: "flex-start" }}><AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} /> Can read but not push: {first(r.output)}</span>
          ) : (
            <span className="row" style={{ gap: 5, alignItems: "flex-start" }}><XCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} /> Can't reach it: {first(r.output)}</span>
          )}
        </div>
      )}
    </div>
  );
}

export function RepoChip({ repo, onFix }: { repo: RepoInfo | null; onFix?: () => void }) {
  if (!repo) {
    return (
      <Hint text="Every project needs a git repository. Click to add one in Project settings.">
        <button className="chip" onClick={onFix} style={{ background: "color-mix(in srgb, var(--warn) 16%, transparent)", color: "var(--warn)", border: 0, cursor: "pointer" }}>
          <AlertTriangle size={11} /> No repository
        </button>
      </Hint>
    );
  }
  const body = (
    <span className="chip" style={{ background: "var(--panel-3)" }}>
      <GitBranch size={11} /> {repo.name} <span className="faint">· {repo.branch}{repo.push ? " · push" : ""}</span>
    </span>
  );
  return (
    <Hint text={`${PROVIDER[repo.provider]} · ${repo.url} · default branch ${repo.branch} · one branch per task. ${repo.push ? "Branches and tags are pushed to origin." : "Local only — nothing is pushed."}`}>
      {repo.webUrl ? <a href={repo.webUrl} target="_blank" rel="noreferrer">{body}</a> : body}
    </Hint>
  );
}

export { GitCommitHorizontal };
