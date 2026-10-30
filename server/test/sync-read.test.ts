import { afterEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { AuditRepository } from "../src/modules/audit/audit.repository.js";

// Browser modules are exercised by Vitest without extending server compilation.
const clientApiUrl = new URL("../../frontend/src/api.ts", import.meta.url).href;
const { apiRequest, readAllPages } = await import(clientApiUrl) as {
  apiRequest<T>(path: string, init?: RequestInit): Promise<T>;
  readAllPages<T>(path: string): Promise<{ items: T[]; total: number }>;
};

afterEach(() => vi.unstubAllGlobals());

describe("continuous synchronization reads", () => {
  it("same query from fifty consumers shares one response", async () => {
    vi.stubGlobal("document", { cookie: "" });
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, status: 200, json: async () => ({ version: 7 }) };
    });
    vi.stubGlobal("fetch", fetch);
    const results = await Promise.all(Array.from({ length: 50 }, () => apiRequest("/fixture/shared")));
    expect(fetch).toHaveBeenCalledOnce();
    expect(results).toEqual(Array(50).fill({ version: 7 }));
  });

  it("cross-project fan-out is bounded and one failure releases its slot", async () => {
    vi.stubGlobal("document", { cookie: "" });
    let active = 0;
    let maximum = 0;
    vi.stubGlobal("fetch", async (path: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      if (path.endsWith("/3")) throw new Error("offline");
      return { ok: true, status: 200, json: async () => ({ path }) };
    });
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => apiRequest("/fixture/project/" + String(index))));
    expect(maximum).toBe(6);
    expect(active).toBe(0);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(39);
    await expect(apiRequest("/fixture/recovery")).resolves.toEqual({ path: "/fixture/recovery" });
  });

  it("collections beyond the first 200 rows remain present", async () => {
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal("fetch", async (path: string) => {
      const page = Number(new URL(path, "http://fixture").searchParams.get("page"));
      const start = (page - 1) * 200;
      return { ok: true, status: 200, json: async () => ({ items: Array.from({ length: Math.min(200, 401 - start) }, (_, index) => ({ id: start + index })), total: 401 }) };
    });
    const result = await readAllPages<{ id: number }>("/fixture/items?q=all");
    expect(result.items).toHaveLength(401);
    expect(result.items.at(-1)).toEqual({ id: 400 });
  });

  it("a read begun before a write is not reused by its reconciliation", async () => {
    vi.stubGlobal("document", { cookie: "" });
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let version = 1;
    let reads = 0;
    vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
      if (init.method === "PATCH") { version = 2; return { ok: true, status: 204 }; }
      const captured = version;
      if (++reads === 1) await pending;
      return { ok: true, status: 200, json: async () => ({ version: captured }) };
    });
    const oldRead = apiRequest("/fixture/causality");
    await apiRequest("/fixture/causality", { method: "PATCH" });
    await expect(apiRequest("/fixture/causality")).resolves.toEqual({ version: 2 });
    release();
    await expect(oldRead).resolves.toEqual({ version: 1 });
    expect(reads).toBe(2);
  });
});

describe("audit hints follow durable writes", () => {
  it("a completed insert publishes only a category, and an insert failure publishes nothing", async () => {
    const values = vi.fn(async () => {});
    const execute = vi.fn(async (_statement: SQL) => {});
    const client = { insert: () => ({ values }), execute };
    const repository = new AuditRepository({} as never);
    const input = { occurredAt: new Date(), actorId: null, actorName: "private", action: "download", objectType: "file", objectId: "private-id", projectId: null, projectCode: null, projectName: null, result: "succeeded", entry: "api", summary: "private summary", changes: null, metadata: {} };
    await repository.insert(client as never, input);
    expect(execute).toHaveBeenCalledOnce();
    const sql = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]!);
    expect(sql.params).toEqual([JSON.stringify({ recipientId: null, event: "invalidate", data: { resources: ["audit"] } })]);
    execute.mockClear();
    values.mockRejectedValueOnce(new Error("rollback"));
    await expect(repository.insert(client as never, input)).rejects.toThrow("rollback");
    expect(execute).not.toHaveBeenCalled();
  });
});
