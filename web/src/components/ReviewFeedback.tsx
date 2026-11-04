import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest, Send } from "lucide-react";
import { api, type WorkItem } from "../lib/api";
import { t } from "../lib/i18n";
import { toast } from "../lib/toast";

/** A reviewer requested changes on the story's PR: their comments, editable, and the button that sends them to the
 *  developer for a rework round on the same PR. */
export function ReviewFeedback({ item }: { item: Pick<WorkItem, "id" | "code" | "pr_url" | "review_feedback"> }) {
  const qc = useQueryClient();
  const [text, setText] = useState(item.review_feedback ?? "");
  useEffect(() => setText(item.review_feedback ?? ""), [item.review_feedback]);
  const send = useMutation({
    mutationFn: () => api.post(`/items/${item.id}/review-feedback`, { feedback: text }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item", item.id] });
      qc.invalidateQueries({ queryKey: ["items"] });
      toast(t("Sent to the developer"));
    },
    onError: (e: Error) => toast(e.message, "bad"),
  });
  return (
    <div className="card card-pad col" style={{ gap: 8, borderColor: "color-mix(in srgb, var(--bad) 40%, var(--line))" }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="strong">{t("The reviewer requested changes")}</span>
        <span className="spacer" />
        {item.pr_url && <a className="btn sm ghost" href={item.pr_url} target="_blank" rel="noopener noreferrer"><GitPullRequest size={13} /> {t("Open the PR")}</a>}
      </div>
      <div className="small muted">{t("Their review and line comments are below. Edit them or write your own, then send them: the developer makes the changes on the same branch, QA re-tests, and the PR goes back to review.")}</div>
      <textarea className="textarea" style={{ minHeight: 140 }} aria-label={t("Feedback for the developer")} value={text} onChange={(e) => setText(e.target.value)} maxLength={20_000} />
      <div className="row">
        <button className="btn sm primary" disabled={send.isPending || !text.trim()} onClick={() => send.mutate()}><Send size={13} /> {t("Send to developer")}</button>
      </div>
    </div>
  );
}
