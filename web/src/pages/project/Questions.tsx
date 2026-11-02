import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, HelpCircle, Send } from "lucide-react";
import { api, type Project, type Question } from "../../lib/api";
import { ago } from "../../lib/format";
import { useAgentLookup } from "../../lib/queries";
import { AgentTag, Empty } from "../../components/ui";
import { toast } from "../../lib/toast";
import { useOpenItem } from "./hooks";
import { Field } from "../../components/Hint";
import { useFresh } from "../../lib/motion";
import { t } from "../../lib/i18n";

function QuestionCard({ q, isNew }: { q: Question; isNew?: boolean }) {
  const agent = useAgentLookup();
  const qc = useQueryClient();
  const open = useOpenItem();
  const [decision, setDecision] = useState(q.answer ?? "");
  const [reasoning, setReasoning] = useState(q.reasoning ?? "");
  const save = useMutation({
    mutationFn: () => api.post(`/questions/${q.id}/answer`, { decision, reasoning }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["questions"] }); qc.invalidateQueries({ queryKey: ["project"] }); toast(t("Answer shared with the team")); },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  const answered = !!q.answer;
  const changed = decision.trim() !== (q.answer ?? "") || reasoning.trim() !== (q.reasoning ?? "");
  return (
    <div className={`card card-pad col ${isNew ? "flash" : ""}`} style={{ gap: 10, borderColor: answered ? undefined : "color-mix(in srgb, var(--warn) 45%, transparent)" }}>
      <div className="row">
        {answered ? <CheckCircle2 size={16} color="var(--good)" /> : <HelpCircle size={16} color="var(--warn)" />}
        <AgentTag agent={agent(q.asked_by)} />
        <span className="small muted">asked {ago(q.created_at)}</span>
        {isNew && <span className="new-badge">new</span>}
        {q.item_code && <button className="code-tag" style={{ cursor: "pointer" }} onClick={() => q.item_id && open(q.item_id)}>{q.item_code}</button>}
      </div>
      <div style={{ fontSize: 14.5, fontWeight: 500 }}>{q.question}</div>
      {q.also_codes?.length ? <div className="tiny muted">{t("Also asked for")} {q.also_codes.join(", ")}</div> : null}
      <div className="col" style={{ gap: 8 }}>
        <Field label={t("Decision")} required help={t("What the agents should do — short and unambiguous, e.g. \"Europe/Stockholm\" or \"Seed it as written\". Every agent that works on the project afterwards gets it, and the stories waiting for it continue.")}>
          <input className="input" placeholder={t("Your decision")} value={decision} onChange={(e) => setDecision(e.target.value)} />
        </Field>
        <Field label={t("Reasoning (optional)")} help={t("Why — helps agents apply the decision to cases the question didn't name.")}>
          <textarea className="textarea" style={{ minHeight: 40 }} placeholder={t("Why, if it helps")} value={reasoning} onChange={(e) => setReasoning(e.target.value)} />
        </Field>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary" disabled={!decision.trim() || !changed || save.isPending} onClick={() => save.mutate()}><Send size={14} /> {answered ? t("Update") : t("Answer")}</button>
        </div>
      </div>
    </div>
  );
}

export default function Questions({ p }: { p: Project }) {
  const { data } = useQuery({ queryKey: ["questions", p.id], queryFn: () => api.get<Question[]>(`/projects/${p.id}/questions`) });
  // Hooks before any early return (an empty list must not change how many hooks run).
  const fresh = useFresh((data ?? []).map((q) => q.id));
  if (data && !data.length) return <Empty icon={<HelpCircle size={20} />} title="No questions yet">When an agent finds an ambiguity it can't resolve from the requirements, it asks you here instead of guessing — and the story waits until you answer.</Empty>;
  const open = (data ?? []).filter((q) => !q.answer);
  const done = (data ?? []).filter((q) => q.answer);
  return (
    <div className="col stagger" style={{ gap: 12, maxWidth: 900 }}>
      {open.map((q) => <QuestionCard key={q.id} q={q} isNew={fresh.has(q.id)} />)}
      {done.length > 0 && <div className="section-title" style={{ marginTop: 10 }}>Answered</div>}
      {done.map((q) => <QuestionCard key={q.id} q={q} />)}
    </div>
  );
}
