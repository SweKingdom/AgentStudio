import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, type WorkItem } from "../../lib/api";

export function useItems(projectId: string) {
  return useQuery({ queryKey: ["items", projectId], queryFn: () => api.get<WorkItem[]>(`/projects/${projectId}/items`) });
}

export function useOpenItem() {
  const [params, setParams] = useSearchParams();
  return (id: string) => {
    params.set("item", id);
    setParams(params);
  };
}
