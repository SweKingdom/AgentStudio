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

function QuestionCard({ q, isNew }: { q: Question; isNew?: boolean }) {
  const agent = useAgentLookup();
  const qc = useQueryClient();
  const open = useOpenItem();
  const [answer, setAnswer] = useState(q.answer ?? "");
  const save = useMutation({
    mutationFn: () => api.post(`/questions/${q.id}/answer`, { answer }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["questions"] }); qc.invalidateQueries({ queryKey: ["project"] }); toast("Answer shared with the team"); },
  });
  const answered = !!q.answer;
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
      <div className="row" style={{ alignItems: "flex-end" }}>
        <Field help="Your decision on this question. It's added to the context of every agent that works on the project afterwards, and the linked story moves back to Ready for Refinement." style={{ flex: 1 }}>
          <textarea className="textarea" style={{ minHeight: 44 }} placeholder="Your answer — it's shared with every agent that works on this project afterwards" value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </Field>
        <button className="btn primary" disabled={!answer.trim() || answer === q.answer} onClick={() => save.mutate()}><Send size={14} /> {answered ? "Update" : "Answer"}</button>
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
