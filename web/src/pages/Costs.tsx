import CostsView from "../components/CostsView";

export default function Costs() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Costs & usage</h1>
          <div className="page-sub">What every agent, task and project costs — and which agents carry the most work. Prices per model are editable in Settings.</div>
        </div>
      </div>
      <CostsView />
    </div>
  );
}
