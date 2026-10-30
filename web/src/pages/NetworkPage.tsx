import NetworkView from "../components/NetworkView";

export default function NetworkPage() {
  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1 className="page-title">Agent network</h1>
          <div className="page-sub">Every handoff, question, answer and rework request between agents across all projects. Edges light up as messages flow.</div>
        </div>
      </div>
      <NetworkView />
    </div>
  );
}
