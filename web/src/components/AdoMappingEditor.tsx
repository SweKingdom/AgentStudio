import type { AdoMapping, StateCategory } from "../lib/api";
import { t } from "../lib/i18n";

const MEANINGS: { value: StateCategory; label: string }[] = [
  { value: "new", label: "Not started" },
  { value: "started", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "dropped", label: "Dropped" },
];
const WRITE_BACK = ["In Progress", "In Peer Testing", "Ready for UAT", "In Review", "Changes Requested", "Release Ready", "Smoke Testing", "Deployed (Done)"];
const FIELDS: [keyof AdoMapping["fields"], string][] = [
  ["title", "Title"],
  ["description", "Description"],
  ["acceptance", "Acceptance criteria"],
  ["points", "Story points"],
  ["assignee", "Assigned to"],
  ["iteration", "Iteration"],
  ["tags", "Tags"],
];

/** The saved mapping between the Azure DevOps board and AgentStudio: what each board state means on import, where
 *  write-back moves AgentStudio's stories, and which fields are read. Worked out from the board; correct it here. */
export function AdoMappingEditor({ value, onChange }: { value: AdoMapping; onChange: (m: AdoMapping) => void }) {
  const states = Object.keys(value.states);
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="grid g2" style={{ gap: 14, alignItems: "start" }}>
        <div className="col" style={{ gap: 6 }}>
          <div className="label">{t("What each board state means")}</div>
          <div className="small muted">{t("Done items come in as delivered and are never rebuilt; someone else's In progress items show as In Progress.")}</div>
          {states.length ? states.map((s) => (
            <div key={s} className="row small" style={{ gap: 8 }}>
              <span style={{ flex: 1 }}>{s}</span>
              <select className="select" style={{ width: 150, height: 28, padding: "2px 8px" }} aria-label={t("Meaning of {s}", { s })} value={value.states[s]} onChange={(e) => onChange({ ...value, states: { ...value.states, [s]: e.target.value as StateCategory } })}>
                {MEANINGS.map((m) => <option key={m.value} value={m.value}>{t(m.label)}</option>)}
              </select>
            </div>
          )) : <div className="small muted">{t("No states read yet: states are judged by their names.")}</div>}
        </div>
        <div className="col" style={{ gap: 6 }}>
          <div className="label">{t("Where write-back moves AgentStudio's stories")}</div>
          <div className="small muted">{t("Only with Write back set to State only, and only forward.")}</div>
          {WRITE_BACK.map((s) => (
            <div key={s} className="row small" style={{ gap: 8 }}>
              <span style={{ flex: 1 }}>{s}</span>
              <select className="select" style={{ width: 150, height: 28, padding: "2px 8px" }} aria-label={t("Board state for {s}", { s })} value={value.writeBack[s] ?? ""} onChange={(e) => {
                const writeBack = { ...value.writeBack };
                if (e.target.value) writeBack[s] = e.target.value;
                else delete writeBack[s];
                onChange({ ...value, writeBack });
              }}>
                <option value="">{t("Leave as it is")}</option>
                {[...new Set([...value.boardStates, ...Object.values(value.writeBack)])].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>
      <details>
        <summary className="small" style={{ cursor: "pointer" }}>{t("Fields and types read from Azure DevOps")}</summary>
        <div className="grid g2" style={{ gap: 8, marginTop: 8 }}>
          {FIELDS.map(([k, label]) => (
            <label key={k} className="row small" style={{ gap: 8 }}>
              <span style={{ width: 140 }}>{t(label)}</span>
              <input className="input mono" style={{ flex: 1, height: 28 }} value={value.fields[k]} spellCheck={false} onChange={(e) => onChange({ ...value, fields: { ...value.fields, [k]: e.target.value } })} />
            </label>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>{t("Types imported")}: {Object.entries(value.types).map(([k, v]) => `${k} → ${v}`).join(" · ")}</div>
      </details>
    </div>
  );
}
