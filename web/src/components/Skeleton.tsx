/** Shimmering placeholder shown while a page loads. */
export function PageSkeleton({ inline }: { inline?: boolean }) {
  const body = (
    <div className="col" style={{ gap: 14 }}>
      <div className="skeleton" style={{ height: 28, width: 280 }} />
      <div className="skeleton" style={{ height: 40 }} />
      <div className="grid g5">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton" style={{ height: 86 }} />)}</div>
      <div className="grid g2">{Array.from({ length: 2 }, (_, i) => <div key={i} className="skeleton" style={{ height: 260 }} />)}</div>
    </div>
  );
  return inline ? body : <div className="page">{body}</div>;
}
