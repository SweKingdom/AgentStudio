import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { closeLive } from "./live";

export type UserRole = "admin" | "member" | "viewer";
export interface AuthUser { id: string; username: string; display_name: string; role: UserRole; disabled: boolean; created_at: string; last_login_at: string | null }
export interface AuthStatus { enabled: boolean; setupNeeded: boolean; user: AuthUser | null }
export interface AuditEntry { id: number; user_id: string | null; username: string | null; action: string; target: string | null; detail: string | null; created_at: string }

/** Fired by the API helper whenever the server answers 401 — the session ended or never existed. */
export const UNAUTHORIZED_EVENT = "arm:unauthorized";

export const ROLE_INFO: Record<UserRole, { label: string; help: string }> = {
  admin: { label: "Admin", help: "Everything, including users, app settings and team conventions." },
  member: { label: "Member", help: "Runs projects: create, start, pause, approve and edit work. Can't change users or app-wide settings." },
  viewer: { label: "Viewer", help: "Read-only: sees projects, documents, code and costs but can't change anything." },
};

/** Sign-in state. Re-checked whenever any API call comes back 401. */
export function useAuth() {
  const qc = useQueryClient();
  useEffect(() => {
    const onUnauthorized = () => qc.invalidateQueries({ queryKey: ["auth"] });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);
  return useQuery({ queryKey: ["auth"], queryFn: () => api.get<AuthStatus>("/auth/status"), staleTime: 60_000, retry: 1 });
}

/** What the signed-in user may do. With login off everyone is effectively an admin (it's a single-user localhost app). */
export function useCan() {
  const { data } = useAuth();
  const role: UserRole = !data?.enabled ? "admin" : data.user?.role ?? "viewer";
  return { role, canWrite: role !== "viewer", isAdmin: role === "admin" };
}

/** After signing in: fetch everything again with the new session. */
export function afterSignIn(qc: QueryClient, status: AuthStatus) {
  qc.setQueryData(["auth"], status);
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
}

export async function signOut(qc: QueryClient) {
  try {
    await api.post("/auth/logout");
  } finally {
    closeLive();
    qc.setQueryData<AuthStatus>(["auth"], { enabled: true, setupNeeded: false, user: null });
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
  }
}
