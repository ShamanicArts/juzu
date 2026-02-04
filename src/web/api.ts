import type { CommitNode } from "../core/types";
import type { OpLogEntry, ObslogEntry } from "../core/jj-api";

async function fetchAPI<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  log: (limit = 500) => fetchAPI<CommitNode[]>(`/api/log?limit=${encodeURIComponent(String(limit))}`),
  files: (changeId: string) => fetchAPI<Array<{ type: string; path: string }>>(`/api/files/${encodeURIComponent(changeId)}`),
  diff: async (changeId: string) => {
    const res = await fetch(`/api/diff/${encodeURIComponent(changeId)}`);
    if (!res.ok) throw new Error(await res.text());
    return await res.text();
  },

  new: (payload: { parentId?: string; parentIds?: string[] }) =>
    fetchAPI<{ success: true }>("/api/new", { method: "POST", body: JSON.stringify(payload) }),
  edit: (payload: { changeId: string }) =>
    fetchAPI<{ success: true }>("/api/edit", { method: "POST", body: JSON.stringify(payload) }),
  describe: (payload: { changeId: string; description: string }) =>
    fetchAPI<{ success: true }>("/api/describe", { method: "POST", body: JSON.stringify(payload) }),
  abandon: (payload: { changeId: string }) =>
    fetchAPI<{ success: true }>("/api/abandon", { method: "POST", body: JSON.stringify(payload) }),
  duplicate: (payload: { changeId: string }) =>
    fetchAPI<{ success: true }>("/api/duplicate", { method: "POST", body: JSON.stringify(payload) }),
  rebase: (payload: { sourceId: string; destinationId: string }) =>
    fetchAPI<{ success: true }>("/api/rebase", { method: "POST", body: JSON.stringify(payload) }),
  undo: () => fetchAPI<{ success: true }>("/api/undo", { method: "POST", body: JSON.stringify({}) }),
  redo: () => fetchAPI<{ success: true }>("/api/redo", { method: "POST", body: JSON.stringify({}) }),
  
  // Op log API
  opLog: (limit = 100) => fetchAPI<OpLogEntry[]>(`/api/oplog?limit=${encodeURIComponent(String(limit))}`),
  restoreOperation: (operationId: string) =>
    fetchAPI<{ success: true }>("/api/oplog/restore", { method: "POST", body: JSON.stringify({ operationId }) }),
  
  // Obslog API
  obslog: (changeId: string, limit = 50) => 
    fetchAPI<ObslogEntry[]>(`/api/obslog/${encodeURIComponent(changeId)}?limit=${encodeURIComponent(String(limit))}`),

  move: (payload: { sourceId: string; destinationId: string }) =>
    fetchAPI<{ success: true }>("/api/move", { method: "POST", body: JSON.stringify(payload) }),
  insert: (payload: { afterId?: string; parentId?: string; childId?: string }) =>
    fetchAPI<{ success: true }>("/api/insert", { method: "POST", body: JSON.stringify(payload) }),
  squash: (payload: { changeId: string; intoId?: string | null; paths?: string[] }) =>
    fetchAPI<{ success: true }>("/api/squash", { method: "POST", body: JSON.stringify(payload) }),
  split: (payload: { changeId: string; paths: string[]; message?: string }) =>
    fetchAPI<{ success: true }>("/api/split", { method: "POST", body: JSON.stringify(payload) }),
};
