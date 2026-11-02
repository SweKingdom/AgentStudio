import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ClipboardList, CloudUpload, Loader2, XCircle } from "lucide-react";
import { api, type Project } from "../lib/api";
import { Markdown } from "./ui";
import { useOpenItem } from "../pages/project/hooks";
import { t } from "../lib/i18n";

interface NextStepsData {
  release: { version: string; created_at: string; status: string } | null;
  steps: { itemId: string; code: string; title: string; pre: boolean; post: boolean; manual: boolean; text: string }[];
  untested: { itemId: string; code: string; ac: string; notes: string }[];
  issues: { id: string; code: string; title: string; state: string; reason: string }[];
  github: { url: string; webUrl: string | null; branch: string; push: boolean; tag: string | null; reachable: boolean; basePushed: boolean | null; unpushed: number | null; tagPushed: boolean | null } | null;
}

function Line({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <div className="row small" style={{ gap: 6 }}>
      {ok === null ? <AlertTriangle size={13} color="var(--warn)" /> : ok ? <CheckCircle2 size={13} color="var(--good)" /> : <XCircle size={13} color="var(--bad)" />}
      <span>{children}</span>
    </div>
  );
}

/** After a release: what a person still has to do, and whether the work is on the remote. */
export function NextSteps({ p }: { p: Project }) {
  const open = useOpenItem();
  const { data, isLoading } = useQuery({ queryKey: ["next-steps", p.id], queryFn: () => api.get<NextStepsData>(`/projects/${p.id}/next-steps`) });
  if (isLoading) return <div className="card card-pad small muted"><Loader2 size={13} className="spin" /> {t("Checking what's left to do…")}</div>;
  if (!data?.release) return null;
  const code = (id: string, c: string) => <button className="code-tag" style={{ cursor: "pointer" }} onClick={() => open(id)}>{c}</button>;
  const g = data.github;
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title"><ClipboardList size={16} color="var(--accent)" /> {t("Next steps")} — {t("release")} {data.release.version}</div>
          <div className="card-sub">{t("What the agents can't do for you: deployment steps, criteria nobody could test, what isn't delivered, and whether everything is on the remote.")}</div>
        </div>
      </div>
      <div className="card-pad col" style={{ gap: 16 }}>
        <section className="col" style={{ gap: 6 }}>
          <div className="strong small">{t("Deployment steps")}</div>
          {data.steps.length ? (
            data.steps.map((s) => (
              <div key={s.itemId} className="col" style={{ gap: 4 }}>
                <div className="row small" style={{ gap: 6 }}>
                  {code(s.itemId, s.code)} {s.title}
                  {s.pre && <span className="chip">{t("Pre-deploy")}</span>}
                  {s.post && <span className="chip">{t("Post-deploy")}</span>}
                  {s.manual && <span className="chip">{t("Manual step")}</span>}
                </div>
                {s.text ? <Markdown>{s.text}</Markdown> : <div className="tiny muted">{t("Tagged, but no steps are written down on the story.")}</div>}
              </div>
            ))
          ) : (
            <div className="small muted">{t("None — no released story has manual or deployment steps.")}</div>
          )}
        </section>

        <section className="col" style={{ gap: 6 }}>
          <div className="strong small">⛔ {t("Verify by hand")} ({data.untested.length})</div>
          {data.untested.length ? (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {data.untested.map((u, i) => <li key={i}>{code(u.itemId, u.code)} {u.ac} — <span className="muted">{u.notes.slice(0, 200)}</span></li>)}
            </ul>
          ) : (
            <div className="small muted">{t("Every acceptance criterion in the release was tested.")}</div>
          )}
        </section>

        <section className="col" style={{ gap: 6 }}>
          <div className="strong small">{t("Known issues")} ({data.issues.length})</div>
          {data.issues.length ? (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {data.issues.map((i) => <li key={i.id}>{code(i.id, i.code)} {i.title} — <span className="muted">{i.reason}</span></li>)}
            </ul>
          ) : (
            <div className="small muted">{t("Every story, task and bug is delivered.")}</div>
          )}
        </section>

        <section className="col" style={{ gap: 6 }}>
          <div className="strong small row" style={{ gap: 6 }}><CloudUpload size={14} /> {t("On the remote")}</div>
          {!g ? (
            <Line ok={false}>{t("No repository is set — the code is only on this computer.")}</Line>
          ) : !g.push ? (
            <Line ok={false}>{t("Push to origin is off — nothing was pushed to")} {g.webUrl ? <a href={g.webUrl} target="_blank" rel="noreferrer">{g.url}</a> : g.url}.</Line>
          ) : !g.reachable ? (
            <Line ok={null}>{t("Couldn't reach the remote to check — try again when online.")}</Line>
          ) : (
            <>
              <Line ok={g.basePushed}>{g.basePushed ? `${g.branch} ${t("is pushed")}` : `${g.branch}: ${g.unpushed ?? "?"} ${t("commit(s) not pushed yet")}`}</Line>
              {g.tag && <Line ok={g.tagPushed}>{g.tagPushed ? `${t("Tag")} ${g.tag} ${t("is pushed")}` : `${t("Tag")} ${g.tag} ${t("isn't on the remote")}`}</Line>}
              {g.webUrl && <a className="small" href={g.webUrl} target="_blank" rel="noreferrer">{g.webUrl}</a>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
