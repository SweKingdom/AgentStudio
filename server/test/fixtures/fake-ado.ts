// A local stand-in for Azure DevOps (nothing real is contacted): WIQL queries (work items and dependency links),
// work items in batches with only the requested fields, work item types with their states and fields, and single
// work items to read and PATCH. Every write and every batch request is recorded for the tests to check.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeItem { id: number; rev?: number; fields: Record<string, unknown>; relations: { rel: string; url: string }[] }
export interface FakeState { name: string; category: string }

export interface FakeAdo {
  url: string;
  items: Map<number, FakeItem>;
  queries: string[];
  batches: { ids: number[]; fields: string[] }[];
  writes: { method: string; path: string; body: any }[];
  close: () => void;
}

const idOf = (url: string) => Number(url.match(/\/workItems\/(\d+)$/i)?.[1]);

export async function startFakeAdo(o: { token: string; project: string; states: FakeState[]; storyFields?: string[] }): Promise<FakeAdo> {
  const items = new Map<number, FakeItem>();
  const fake = { items, queries: [] as string[], batches: [] as { ids: number[]; fields: string[] }[], writes: [] as { method: string; path: string; body: any }[] };
  const base = `/fakeorg/${o.project}/_apis/wit`;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const path = decodeURIComponent(url.pathname);
      const body = raw ? JSON.parse(raw) : null;
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Basic ${Buffer.from(`:${o.token}`).toString("base64")}`) return send(401, { message: "Unauthorized" });
      let m: RegExpMatchArray | null;
      if (req.method === "POST" && path === `${base}/wiql`) {
        fake.queries.push(body.query);
        if (/FROM WorkItemLinks/i.test(body.query)) {
          const ids = (body.query.match(/IN \(([^)]*)\)/)?.[1] ?? "").split(",").map((x: string) => Number(x.trim()));
          const rels = ids.flatMap((id: number) => (items.get(id)?.relations ?? []).filter((r) => r.rel === "System.LinkTypes.Dependency-Reverse").map((r) => ({ rel: r.rel, source: { id }, target: { id: idOf(r.url) } })));
          return send(200, { workItemRelations: [...ids.map((id: number) => ({ rel: null, source: null, target: { id } })), ...rels] });
        }
        return send(200, { workItems: [...items.keys()].map((id) => ({ id })) });
      }
      if (req.method === "POST" && path === `${base}/workitemsbatch`) {
        fake.batches.push({ ids: body.ids, fields: body.fields });
        if (body.$expand) return send(400, { message: "The expand parameter can not be used with the fields parameter." });
        const value = body.ids.map((id: number) => items.get(id)).filter(Boolean).map((it: FakeItem) => {
          const parent = it.relations.find((r) => r.rel === "System.LinkTypes.Hierarchy-Reverse");
          const all: Record<string, unknown> = { ...it.fields, "System.Id": it.id, "System.Rev": it.rev ?? 1, ...(parent ? { "System.Parent": idOf(parent.url) } : {}) };
          return { id: it.id, rev: it.rev ?? 1, fields: Object.fromEntries(Object.entries(all).filter(([k]) => body.fields.includes(k))) };
        });
        return send(200, { count: value.length, value });
      }
      if (req.method === "GET" && path === `${base}/workitemtypes`) {
        const fields = (o.storyFields ?? ["System.Title", "System.Description", "Microsoft.VSTS.Common.AcceptanceCriteria", "Microsoft.VSTS.Scheduling.StoryPoints"]).map((referenceName) => ({ referenceName }));
        const types = ["Epic", "Feature", "User Story", "Task", "Bug", "Test Case"].map((name) => ({ name, states: o.states, fields: name === "User Story" ? fields : [] }));
        return send(200, { count: types.length, value: types });
      }
      if (req.method === "GET" && path === `${base}/workitemtypes/User Story/states`) return send(200, { value: o.states });
      if ((m = path.match(/^\/fakeorg\/_apis\/wit\/workitems\/(\d+)$/))) {
        const it = items.get(Number(m[1]));
        if (!it) return send(404, { message: "no such item" });
        if (req.method === "GET") return send(200, { id: it.id, fields: it.fields });
        if (req.method === "PATCH") {
          fake.writes.push({ method: "PATCH", path, body });
          for (const op of body) it.fields[op.path.replace("/fields/", "")] = op.value;
          it.rev = (it.rev ?? 1) + 1;
          return send(200, { id: it.id, fields: it.fields });
        }
      }
      fake.writes.push({ method: req.method!, path, body });
      send(405, { message: `Not allowed in the stand-in: ${req.method} ${path}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/fakeorg`, ...fake, close: () => server.close() };
}
