import { useQuery } from "@tanstack/react-query";
import { api, type Agent, type Meta, type Project } from "./api";

export function useMeta() {
  return useQuery({ queryKey: ["meta"], queryFn: () => api.get<Meta>("/meta"), staleTime: 30_000 });
}

export function useAgents() {
  return useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/agents") });
}

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/projects") });
}

export interface AgentLike { id: string; name: string; color: string; icon: string; role: string; title: string }

/** Lookup for real agents + pseudo agents (orchestrator, human). */
export function useAgentLookup() {
  const { data: agents } = useAgents();
  const { data: meta } = useMeta();
  return (id: string | null | undefined): AgentLike => {
    const a = agents?.find((x) => x.id === id) ?? meta?.pseudoAgents.find((x) => x.id === id);
    return a ?? { id: id ?? "?", name: id === "human" ? "You" : "Unknown agent", color: "#5c6478", icon: "Bot", role: "?", title: "" };
  };
}
