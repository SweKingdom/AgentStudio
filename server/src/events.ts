import type { Response } from "express";

/** Server-sent events bus. Clients subscribe globally; events carry an optional projectId. */
export interface ArmEvent {
  type:
    | "project"
    | "item"
    | "run"
    | "activity"
    | "message"
    | "cost"
    | "document"
    | "file"
    | "question"
    | "agent";
  projectId?: string | null;
  data?: unknown;
}

const clients = new Set<Response>();

export function subscribe(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emit(event: ArmEvent) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(payload);
}
