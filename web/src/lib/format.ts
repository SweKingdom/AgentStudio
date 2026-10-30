let currency: "USD" | "EUR" = "USD";
let usdToEur = 0.92;
export function setCurrency(c: "USD" | "EUR", rate: number) {
  currency = c;
  usdToEur = rate;
}

export function money(usd: number | null | undefined, digits?: number) {
  const v = (usd ?? 0) * (currency === "EUR" ? usdToEur : 1);
  const d = digits ?? (Math.abs(v) < 1 ? 3 : Math.abs(v) < 100 ? 2 : 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
}

export function tokens(n: number | null | undefined) {
  const v = n ?? 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(v));
}

export function num(n: number | null | undefined, digits = 0) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n ?? 0);
}

export function duration(seconds: number | null | undefined) {
  if (seconds == null || !isFinite(seconds)) return "—";
  const s = Math.max(0, seconds);
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${(s / 86400).toFixed(1)}d`;
}

export function hours(h: number | null | undefined) {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 40) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${Math.round(h)} h`;
}

export function ago(iso: string | null | undefined) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 5) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function dateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function secondsBetween(a: string, b: string | null) {
  return (new Date(b ?? Date.now()).getTime() - new Date(a).getTime()) / 1000;
}

export function title(s: string) {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
