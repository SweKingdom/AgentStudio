import { all, insert, now } from "./db.js";
import { emit } from "./events.js";
import { effectiveMode } from "./settings.js";
import { getProject, postMessage, type Project } from "./store.js";
import { buildSystemPrompt, liveChat, recordCall } from "./agents/runner.js";
import { simulateChat } from "./agents/simulator.js";
import type { Agent } from "./agents/store.js";

export interface ChatMessage {
  id: number;
  agent_id: string;
  project_id: string | null;
  sender: "human" | "agent";
  content: string;
  created_at: string;
}

export function chatHistory(agentId: string, projectId: string | null) {
  return all<ChatMessage>(
    `SELECT * FROM chats WHERE agent_id = ? AND ${projectId ? "project_id = ?" : "project_id IS NULL"} ORDER BY id`,
    ...(projectId ? [agentId, projectId] : [agentId]),
  );
}

function save(agentId: string, projectId: string | null, sender: "human" | "agent", content: string) {
  insert("chats", { agent_id: agentId, project_id: projectId, sender, content, created_at: now() });
  if (projectId) {
    postMessage({ projectId, from: sender === "human" ? "human" : agentId, to: sender === "human" ? agentId : "human", kind: sender === "human" ? "question" : "answer", content });
  }
}

/** Talk to an agent. Simulation answers from the agent's real state; live mode (when enabled) asks Claude. */
export async function chat(agent: Agent, projectId: string | null, message: string) {
  const project: Project | null = projectId ? getProject(projectId) ?? null : null;
  save(agent.id, project?.id ?? null, "human", message);
  const started = Date.now();
  let reply: string;
  const live = effectiveMode() === "live" && project?.mode !== "simulation";
  if (live) {
    reply = await liveChat(agent, project, chatHistory(agent.id, project?.id ?? null), message);
  } else {
    reply = await simulateChat(agent, project, message);
    if (project) {
      recordCall({
        runId: null,
        projectId: project.id,
        agentId: agent.id,
        stage: "chat",
        model: agent.model,
        usage: {
          input_tokens: Math.round(message.length / 3.6) + 400,
          output_tokens: Math.round(reply.length / 3.6) + 150,
          cache_read_tokens: Math.round(buildSystemPrompt(agent).length / 3.6),
          cache_write_tokens: 0,
        },
        durationMs: Date.now() - started,
        simulated: true,
      });
    }
  }
  save(agent.id, project?.id ?? null, "agent", reply);
  emit({ type: "agent", data: { chat: agent.id } });
  return chatHistory(agent.id, project?.id ?? null);
}
