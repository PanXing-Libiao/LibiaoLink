import { afterEach, describe, expect, it, vi } from "vitest";
import { firstValueFrom, of, throwError } from "rxjs";
import { changedResources, ResourceChangeInterceptor } from "../src/common/realtime/resource-change.js";
import { ResourceChangePublisher } from "../src/modules/notify/resource-change.publisher.js";
import { NotifyStreamWireSchema } from "../src/modules/notify/notify.stream.js";

// Load browser code at test runtime; server compilation has no DOM library.
const clientSyncUrl = new URL("../../frontend/src/liveSync.ts", import.meta.url).href;
const { keepLiveOrder, RefreshQueue } = await import(clientSyncUrl) as {
  keepLiveOrder<T extends { id: string | number }>(previous: readonly T[], next: readonly T[]): T[];
  RefreshQueue: new (read: () => Promise<() => void>, paused?: () => boolean, revision?: () => number) => { request(): void; dispose(): void };
};

afterEach(() => vi.useRealTimers());

describe("shared-page invalidation", () => {
  it("only successful business writes publish hints; reads, upload parts and personal preferences do not", async () => {
    expect(changedResources("GET", "/api/v1/projects")).toEqual([]);
    expect(changedResources("POST", "/api/v1/files/a/uploads/b/parts")).toEqual([]);
    expect(changedResources("PATCH", "/api/v1/users/me/preferences")).toEqual([]);
    expect(changedResources("PATCH", "/api/v1/projects/a/tasks/b")).toContain("tasks");
    expect(changedResources("POST", "/api/v1/files/a/uploads/b/complete")).toContain("files");
    // 导入表导入（Push 316 服务端落地）：只有 commit 写业务数据；preview 只落票据，不触发刷新
    expect(changedResources("POST", "/api/v1/project-imports/preview")).toEqual([]);
    expect(changedResources("POST", "/api/v1/project-imports/commit")).toEqual(
      expect.arrayContaining(["projects", "tasks", "reports", "issues", "files", "templates"]),
    );
    const changed = vi.fn();
    const interceptor = new ResourceChangeInterceptor({ changed });
    const context = { switchToHttp: () => ({ getRequest: () => ({ method: "PATCH", url: "/api/v1/projects/a/tasks/b" }) }) };
    await expect(firstValueFrom(interceptor.intercept(context as never, { handle: () => throwError(() => new Error("rollback")) }))).rejects.toThrow("rollback");
    expect(changed).not.toHaveBeenCalled();
    await firstValueFrom(interceptor.intercept(context as never, { handle: () => of({ version: 2 }) }));
    expect(changed).toHaveBeenCalledOnce();
  });

  it("ten simultaneous writers coalesce; slow publishing never creates parallel queries", async () => {
    vi.useFakeTimers();
    let resolve: (() => void) | undefined;
    const query = vi.fn((_query: string, _values: readonly string[]) => new Promise<void>((done) => { resolve = done; }));
    const publisher = new ResourceChangePublisher({ pool: { query } } as never);
    for (let writer = 0; writer < 10; writer += 1) publisher.changed(["tasks", "projects"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(query).toHaveBeenCalledOnce();
    expect(JSON.parse(query.mock.calls[0]![1]![1] as string)).toEqual({ recipientId: null, event: "invalidate", data: { resources: ["tasks", "projects"] } });
    for (let writer = 0; writer < 10; writer += 1) publisher.changed(["files"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(query).toHaveBeenCalledOnce();
    resolve?.();
    await vi.advanceTimersByTimeAsync(250);
    expect(query).toHaveBeenCalledTimes(2);
    resolve?.();
    publisher.onApplicationShutdown();
  });

  it("broadcast hints contain no ids or business fields and reject unknown resources", () => {
    const parsed = NotifyStreamWireSchema.parse({ recipientId: null, event: "invalidate", data: { resources: ["tasks"], projectId: "secret", title: "secret" } });
    expect(parsed.data).toEqual({ resources: ["tasks"] });
    expect(NotifyStreamWireSchema.safeParse({ recipientId: null, event: "invalidate", data: { resources: ["unknown"] } }).success).toBe(false);
    expect(NotifyStreamWireSchema.safeParse({ recipientId: "user", event: "invalidate", data: { resources: ["tasks"] } }).success).toBe(false);
  });
});

describe("silent client refresh queue", () => {
  it("ten clients with continuous notifications keep updating and have at most one in-flight read each", async () => {
    vi.useFakeTimers();
    const reads = Array(10).fill(0) as number[];
    const commits = Array(10).fill(0) as number[];
    const active = Array(10).fill(0) as number[];
    const maximum = Array(10).fill(0) as number[];
    const queues = reads.map((_, index) => new RefreshQueue(async () => {
      reads[index]! += 1;
      active[index]! += 1;
      maximum[index] = Math.max(maximum[index]!, active[index]!);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      active[index]! -= 1;
      return () => { commits[index]! += 1; };
    }, () => false));
    for (let step = 0; step < 100; step += 1) {
      for (const queue of queues) queue.request();
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(maximum).toEqual(Array(10).fill(1));
    expect(reads.every((count) => count >= 4 && count <= 6)).toBe(true);
    expect(commits.every((count) => count >= 4)).toBe(true);
    queues.forEach((queue) => queue.dispose());
  });

  it("editing pauses updates; a draft started during a read discards that read and catches up after editing", async () => {
    vi.useFakeTimers();
    let editing = true;
    let revision = 0;
    const applied = vi.fn();
    const read = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); return applied; });
    const queue = new RefreshQueue(read, () => editing, () => revision);
    queue.request();
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).not.toHaveBeenCalled();
    editing = false;
    await vi.advanceTimersByTimeAsync(1000);
    revision += 1;
    editing = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(applied).not.toHaveBeenCalled();
    editing = false;
    await vi.advanceTimersByTimeAsync(1200);
    expect(applied).toHaveBeenCalledOnce();
    queue.dispose();
  });

  it("failed reads preserve the screen, recover on the next hint, and disposed subscriptions cannot apply delayed responses", async () => {
    vi.useFakeTimers();
    const applied = vi.fn();
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(applied);
    const queue = new RefreshQueue(read, () => false);
    queue.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(applied).not.toHaveBeenCalled();
    queue.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(applied).toHaveBeenCalledOnce();
    queue.dispose();
    let finish: ((apply: () => void) => void) | undefined;
    const pending = new RefreshQueue(() => new Promise((resolve) => { finish = resolve; }), () => false);
    pending.request();
    await vi.advanceTimersByTimeAsync(1000);
    pending.dispose();
    finish?.(applied);
    await vi.advanceTimersByTimeAsync(1000);
    expect(applied).toHaveBeenCalledOnce();
  });

  it("remote sorting updates values without moving existing rows; new rows append and deleted rows disappear", () => {
    expect(keepLiveOrder([{ id: "a", value: 1 }, { id: "b", value: 1 }], [{ id: "b", value: 2 }, { id: "c", value: 3 }, { id: "a", value: 2 }])).toEqual([{ id: "a", value: 2 }, { id: "b", value: 2 }, { id: "c", value: 3 }]);
    expect(keepLiveOrder([{ id: "a" }, { id: "b" }], [{ id: "b" }])).toEqual([{ id: "b" }]);
  });
});
