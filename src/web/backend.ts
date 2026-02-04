import type { JJBackend } from "../core/backend";
import { api } from "./api";

export function createWebBackend(): JJBackend {
  return {
    log: async ({ limit }) => api.log(limit),
    files: async ({ changeId }) => api.files(changeId),
    diff: async ({ changeId }) => api.diff(changeId),

    new: async ({ parentId, parentIds }) => {
      await api.new({ parentId, parentIds });
    },
    edit: async ({ changeId }) => {
      await api.edit({ changeId });
    },
    describe: async ({ changeId, description }) => {
      await api.describe({ changeId, description });
    },
    abandon: async ({ changeId }) => {
      await api.abandon({ changeId });
    },
    duplicate: async ({ changeId }) => {
      await api.duplicate({ changeId });
    },
    rebase: async ({ sourceId, destinationId }) => {
      await api.rebase({ sourceId, destinationId });
    },
    undo: async () => {
      await api.undo();
    },
    redo: async () => {
      await api.redo();
    },

    move: async ({ sourceId, destinationId }) => {
      await api.move({ sourceId, destinationId });
    },
    insert: async ({ afterId, parentId, childId }) => {
      await api.insert({ afterId, parentId, childId });
    },
    squash: async ({ changeId, intoId, paths }) => {
      await api.squash({ changeId, intoId: intoId ?? undefined, paths });
    },
    split: async ({ changeId, paths, message }) => {
      await api.split({ changeId, paths, message });
    },

    opLog: async ({ limit }) => api.opLog(limit),
    restoreOperation: async ({ operationId }) => {
      await api.restoreOperation(operationId);
    },
    obslog: async ({ changeId, limit }) => api.obslog(changeId, limit),
  };
}
