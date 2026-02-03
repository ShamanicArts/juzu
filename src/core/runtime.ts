import type { JJBackend } from "./backend";

let backend: JJBackend | null = null;

export function setBackend(next: JJBackend) {
  backend = next;
}

export function getBackend(): JJBackend {
  if (!backend) {
    throw new Error("JJ backend not configured. Call setBackend() at app startup.");
  }
  return backend;
}
