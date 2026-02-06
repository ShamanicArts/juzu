import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { createTempJJRepo, type TempJJRepo } from "../../src/test-utils/temp-repo";

const workspaceRoot = "/home/shamanic/dev/jj-viz";

type StartedServer = {
  baseUrl: string;
  stop: () => Promise<void>;
};

type ApiNode = {
  changeId: string;
};

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("could not resolve free port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

async function waitForServer(baseUrl: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/log?limit=5`);
      if (r.ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(100);
  }
  throw new Error(`server did not become ready: ${baseUrl}`);
}

async function startServer(repoPath: string): Promise<StartedServer> {
  const port = await getFreePort();
  const proc = Bun.spawn([
    "bun",
    "run",
    join(workspaceRoot, "server.ts"),
    `--port=${port}`,
  ], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl);

  return {
    baseUrl,
    stop: async () => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      await proc.exited;
    },
  };
}

async function expectJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected json response, got: ${text}`);
  }
}

async function waitForSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>, eventName: string, timeoutMs = 8000): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffered = "";

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => ({ done: true as const, value: undefined })),
    ]);
    const chunk = await next;
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    if (buffered.includes(`event: ${eventName}`)) {
      return buffered;
    }
  }

  throw new Error(`timed out waiting for SSE event ${eventName}`);
}

describe("server API integration smoke", () => {
  let repo: TempJJRepo;
  let server: StartedServer;
  let selectedChangeId = "";

  beforeAll(async () => {
    repo = await createTempJJRepo();
    await Bun.write(join(repo.path, "README.md"), "seed\n");
    await repo.run(["jj", "describe", "-m", "seed"]);
    await repo.run(["jj", "new"]);
    server = await startServer(repo.path);

    const logResp = await fetch(`${server.baseUrl}/api/log?limit=20`);
    const nodes = (await expectJson(logResp)) as ApiNode[];
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);
    selectedChangeId = nodes[0]!.changeId;
  });

  afterAll(async () => {
    if (server) await server.stop();
    if (repo) await repo.cleanup();
  });

  test("GET /api/log returns node array", async () => {
    const resp = await fetch(`${server.baseUrl}/api/log?limit=10`);
    expect(resp.status).toBe(200);
    const body = await expectJson(resp);
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/log supports revset filtering", async () => {
    const resp = await fetch(`${server.baseUrl}/api/log?limit=10&revset=${encodeURIComponent("@")}`);
    expect(resp.status).toBe(200);
    const body = await expectJson(resp);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test("GET /api/files/:id and /api/diff/:id return data", async () => {
    const filesResp = await fetch(`${server.baseUrl}/api/files/${selectedChangeId}`);
    expect(filesResp.status).toBe(200);
    const files = await expectJson(filesResp);
    expect(Array.isArray(files)).toBe(true);

    const diffResp = await fetch(`${server.baseUrl}/api/diff/${selectedChangeId}`);
    expect(diffResp.status).toBe(200);
    const diffText = await diffResp.text();
    expect(typeof diffText).toBe("string");
  });

  test("GET /api/oplog and /api/obslog/:id return arrays", async () => {
    const oplogResp = await fetch(`${server.baseUrl}/api/oplog?limit=20`);
    expect(oplogResp.status).toBe(200);
    const oplog = await expectJson(oplogResp);
    expect(Array.isArray(oplog)).toBe(true);

    const obslogResp = await fetch(`${server.baseUrl}/api/obslog/${selectedChangeId}?limit=20`);
    expect(obslogResp.status).toBe(200);
    const obslog = await expectJson(obslogResp);
    expect(Array.isArray(obslog)).toBe(true);
  });

  test("serves web shell and bundled app", async () => {
    const rootResp = await fetch(`${server.baseUrl}/`);
    expect(rootResp.status).toBe(200);
    const rootHtml = await rootResp.text();
    expect(rootHtml.includes("jj-viz")).toBe(true);

    const appResp = await fetch(`${server.baseUrl}/web/app.js`);
    expect(appResp.status).toBe(200);
    const js = await appResp.text();
    expect(js.length).toBeGreaterThan(1000);
  });

  test("SSE endpoint streams ready and repo-updated events", async () => {
    const eventsResp = await fetch(`${server.baseUrl}/api/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(eventsResp.status).toBe(200);
    expect(eventsResp.headers.get("content-type")?.includes("text/event-stream")).toBe(true);
    expect(eventsResp.body).toBeTruthy();

    const reader = eventsResp.body!.getReader();
    await waitForSseEvent(reader, "ready", 5000);

    await repo.run(["jj", "new"]);
    const payload = await waitForSseEvent(reader, "repo-updated", 8000);
    expect(payload.includes("event: repo-updated")).toBe(true);

    await reader.cancel();
  });

  test("POST mutation endpoints return expected contract shape", async () => {
    const describeResp = await fetch(`${server.baseUrl}/api/describe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ changeId: selectedChangeId, description: "integration test" }),
    });
    const describeBody = await expectJson(describeResp);
    expect(describeResp.status).toBe(200);
    expect(describeBody.success).toBe(true);

    const rebaseResp = await fetch(`${server.baseUrl}/api/rebase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "badbad", destinationId: "also-bad" }),
    });
    const rebaseBody = await expectJson(rebaseResp);
    expect(rebaseResp.status).toBe(400);
    expect(typeof rebaseBody.error).toBe("string");

    const abandonResp = await fetch(`${server.baseUrl}/api/abandon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ changeId: "badbad" }),
    });
    const abandonBody = await expectJson(abandonResp);
    expect(abandonResp.status).toBe(400);
    expect(typeof abandonBody.error).toBe("string");

    const undoResp = await fetch(`${server.baseUrl}/api/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const undoBody = await expectJson(undoResp);
    expect(typeof undoBody.success).toBe("boolean");
    if (undoBody.success === false) {
      expect(typeof undoBody.error).toBe("string");
    }

    const redoResp = await fetch(`${server.baseUrl}/api/redo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const redoBody = await expectJson(redoResp);
    expect(typeof redoBody.success).toBe("boolean");
    if (redoBody.success === false) {
      expect(typeof redoBody.error).toBe("string");
    }
  });

  test("POST bookmark and restore endpoints", async () => {
    const setResp = await fetch(`${server.baseUrl}/api/bookmark/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "it-bookmark", revision: selectedChangeId }),
    });
    expect(setResp.status).toBe(200);

    const renameResp = await fetch(`${server.baseUrl}/api/bookmark/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldName: "it-bookmark", newName: "it-bookmark-renamed" }),
    });
    expect(renameResp.status).toBe(200);

    const restoreResp = await fetch(`${server.baseUrl}/api/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ changeId: selectedChangeId }),
    });
    const restoreBody = await expectJson(restoreResp);
    expect([200, 400]).toContain(restoreResp.status);
    if (restoreResp.status === 200) expect(restoreBody.success).toBe(true);
    else expect(typeof restoreBody.error).toBe("string");

    const deleteResp = await fetch(`${server.baseUrl}/api/bookmark/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "it-bookmark-renamed" }),
    });
    expect(deleteResp.status).toBe(200);
  });

  test("POST track/untrack and fetch/push return contract", async () => {
    const trackResp = await fetch(`${server.baseUrl}/api/bookmark/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteBookmark: "main@origin" }),
    });
    const trackBody = await expectJson(trackResp);
    expect([200, 400]).toContain(trackResp.status);
    if (trackResp.status !== 200) expect(typeof trackBody.error).toBe("string");

    const untrackResp = await fetch(`${server.baseUrl}/api/bookmark/untrack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteBookmark: "main@origin" }),
    });
    const untrackBody = await expectJson(untrackResp);
    expect([200, 400]).toContain(untrackResp.status);
    if (untrackResp.status !== 200) expect(typeof untrackBody.error).toBe("string");

    const fetchResp = await fetch(`${server.baseUrl}/api/git/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const fetchBody = await expectJson(fetchResp);
    expect([200, 400]).toContain(fetchResp.status);
    if (fetchResp.status !== 200) expect(typeof fetchBody.error).toBe("string");

    const pushResp = await fetch(`${server.baseUrl}/api/git/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const pushBody = await expectJson(pushResp);
    expect([200, 400]).toContain(pushResp.status);
    if (pushResp.status !== 200) expect(typeof pushBody.error).toBe("string");
  });
});
