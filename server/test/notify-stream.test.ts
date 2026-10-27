/**
 * SSE 实时流服务回归（S8-3 · M5-04-1）：连接注册与每用户上限拒新、广播扇出与跨用户隔离、
 * 非法载荷告警丢弃、心跳与优雅关闭注释行、轮询兜底、惰性 LISTEN（首个连接才建桥）、广播桥掉线重连、
 * 发布器事务内 pg_notify（通道 / 载荷形状）。PG / express 全替身，不连库不占端口。
 * 真机口径见 server/scripts/m5-04-1-sse-replay.mjs 与 server/src/modules/notify/README.md。
 */
import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import type { Notification } from "@libiaolink/contracts";
import { AppConfig } from "../src/config/config.module.js";
import { loadEnv } from "../src/config/env.js";
import { NotifyStreamPublisher } from "../src/modules/notify/notify.stream.publisher.js";
import { NotifyStreamService, type NotifyStreamSink } from "../src/modules/notify/notify.stream.service.js";
import { frameOf } from "../src/modules/notify/notify.stream.js";

const ME = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const OTHER = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const DAYTIME = new Date("2026-09-28T06:00:00.000Z");

class FakeSink implements NotifyStreamSink {
  chunks: string[] = [];
  ended = 0;

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  end(): void {
    this.ended += 1;
  }
}

/** LISTEN 连接替身：记录 LISTEN 查询、可控触发 notification / error / end。 */
class FakeListenerClient {
  notificationHandler: ((message: { channel: string; payload?: string }) => void) | null = null;
  errorHandler: ((error: Error) => void) | null = null;
  endHandler: (() => void) | null = null;
  queries: string[] = [];
  /** 调用序列（connect / query:…）：回归 M5-04-1 真机回放根因 —— 必须先 connect 再 LISTEN。 */
  events: string[] = [];
  ended = 0;

  on(event: string, listener: (...args: never[]) => void): unknown {
    if (event === "notification") this.notificationHandler = listener as (message: { channel: string; payload?: string }) => void;
    else if (event === "error") this.errorHandler = listener as (error: Error) => void;
    else if (event === "end") this.endHandler = listener as () => void;
    return this;
  }

  async connect(): Promise<void> {
    this.events.push("connect");
  }

  async query(text: string): Promise<unknown> {
    this.queries.push(text);
    this.events.push("query:" + text);
    return undefined;
  }

  async end(): Promise<void> {
    this.ended += 1;
    const handler = this.endHandler;
    this.endHandler = null;
    handler?.();
  }

  emitNotification(payload: string, channel = "notify_stream"): void {
    this.notificationHandler?.({ channel, payload });
  }
}

class TestStreamService extends NotifyStreamService {
  readonly clients: FakeListenerClient[] = [];

  protected override createListenerClient(): Client {
    const client = new FakeListenerClient();
    this.clients.push(client);
    return client as unknown as Client;
  }
}

class FakeNotifyRepository {
  unread = 0;
  countUnreadCalls: string[] = [];

  async countUnread(userId: string): Promise<number> {
    this.countUnreadCalls.push(userId);
    return this.unread;
  }
}

function makeService(overrides: Record<string, string> = {}) {
  const env = loadEnv({
    DATABASE_URL: "postgresql://unused",
    NOTIFY_STREAM_MAX_CONNECTIONS: "3",
    NOTIFY_STREAM_HEARTBEAT_MS: "25000",
    NOTIFY_STREAM_POLL_MS: "0",
    ...overrides,
  });
  const repository = new FakeNotifyRepository();
  const service = new TestStreamService(repository as never, new AppConfig(env));
  return { service, repository };
}

/** 事件循环微任务冲洗（假时钟下替代 vi.waitFor）。 */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function notificationOf(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    type: "reminder",
    title: "日报未填",
    body: "请补填日报",
    status: "unread",
    refType: null,
    refId: null,
    projectId: null,
    templateCode: null,
    mergedCount: 1,
    snoozeUntil: null,
    deliveredAt: DAYTIME.toISOString(),
    createdAt: DAYTIME.toISOString(),
    ...overrides,
  };
}

function wireNotification(userId: string, overrides: Partial<Notification> = {}): string {
  return JSON.stringify({ recipientId: userId, event: "notification", data: notificationOf(overrides) });
}

describe("SSE 实时流（S8-3 · M5-04-1）", () => {
  it("业务失效提示扇出到十名在线用户，仅发送资源类别", async () => {
    const { service } = makeService();
    const sinks = Array.from({ length: 10 }, (_, index) => {
      const sink = new FakeSink();
      service.open("fixture-user-" + String(index), sink);
      return sink;
    });
    await vi.waitFor(() => expect(service.clients[0]?.queries).toContain("LISTEN notify_stream"));
    service.clients[0]!.emitNotification(JSON.stringify({ recipientId: null, event: "invalidate", data: { resources: ["tasks"], projectId: "private" } }));
    await vi.waitFor(() => expect(sinks[0]?.chunks.length).toBe(1));
    for (const sink of sinks) expect(sink.chunks).toEqual(['event: invalidate\ndata: {"resources":["tasks"]}\n\n']);
    await service.onApplicationShutdown();
  });
  it("同账号偏好仅到本人所有连接，连续提示合并且不同账号隔离", async () => {
    vi.useFakeTimers();
    try {
      const { service } = makeService();
      const first = new FakeSink(); const second = new FakeSink(); const other = new FakeSink();
      service.open(ME, first); service.open(ME, second); service.open(OTHER, other);
      await flushMicrotasks();
      for (let index = 0; index < 100; index += 1) service.clients[0]!.emitNotification(JSON.stringify({ recipientId: ME, event: "invalidate", data: { resources: ["preferences"] } }));
      await vi.advanceTimersByTimeAsync(250);
      expect(first.chunks).toEqual([frameOf("invalidate", { resources: ["preferences"] })]);
      expect(second.chunks).toEqual(first.chunks);
      expect(other.chunks).toEqual([]);
      await service.onApplicationShutdown();
    } finally { vi.useRealTimers(); }
  });
  it("建立连接：计数 + 惰性 LISTEN（首个连接才建桥）且不发初始帧", async () => {
    const { service } = makeService();
    expect(service.clients).toHaveLength(0);
    const sink = new FakeSink();
    const connection = service.open(ME, sink);
    expect(connection).not.toBeNull();
    expect(service.connectionCount(ME)).toBe(1);
    expect(sink.chunks).toEqual([]);
    await vi.waitFor(() => {
      expect(service.clients).toHaveLength(1);
      expect(service.clients[0]?.queries).toContain("LISTEN notify_stream");
    });
    // 回归（M5-04-1 真机回放根因）：pg v8 未连接时 query 只入队不派发 —— 必须先 connect 再 LISTEN。
    expect(service.clients[0]?.events).toEqual(["connect", "query:LISTEN notify_stream"]);

    service.open(ME, new FakeSink());
    await flushMicrotasks();
    expect(service.clients).toHaveLength(1);
    connection?.close();
  });

  it("每用户连接上限：超限拒新（不触碰既有连接）；关闭后空位可复用", () => {
    const { service } = makeService({ NOTIFY_STREAM_MAX_CONNECTIONS: "2" });
    const first = service.open(ME, new FakeSink());
    const second = service.open(ME, new FakeSink());
    const refused = new FakeSink();
    expect(service.open(ME, refused)).toBeNull();
    expect(service.connectionCount(ME)).toBe(2);
    expect(refused.chunks).toEqual([]);
    expect(refused.ended).toBe(0);

    second?.close();
    expect(service.connectionCount(ME)).toBe(1);
    const third = service.open(ME, new FakeSink());
    expect(third).not.toBeNull();
    expect(service.connectionCount(ME)).toBe(2);
    first?.close();
    third?.close();
    expect(service.connectionCount(ME)).toBe(0);
  });

  it("广播扇出：notification / unread 只到本人连接（跨用户隔离）", async () => {
    const { service } = makeService();
    const mine = new FakeSink();
    const other = new FakeSink();
    service.open(ME, mine);
    service.open(OTHER, other);
    await vi.waitFor(() => {
      expect(service.clients).toHaveLength(1);
      expect(service.clients[0]?.queries).toContain("LISTEN notify_stream");
    });
    const client = service.clients[0]!;

    client.emitNotification(wireNotification(ME));
    client.emitNotification(JSON.stringify({ recipientId: ME, event: "unread", data: { unreadCount: 2 } }));
    expect(mine.chunks).toEqual([
      frameOf("notification", notificationOf()),
      frameOf("unread", { unreadCount: 2 }),
    ]);
    expect(other.chunks).toEqual([]);
  });

  it("广播载荷非法（JSON 坏 / 结构不符 / 通道不符）：告警丢弃且不影响后续事件", async () => {
    const { service } = makeService();
    const sink = new FakeSink();
    service.open(ME, sink);
    await vi.waitFor(() => {
      expect(service.clients).toHaveLength(1);
      expect(service.clients[0]?.queries).toContain("LISTEN notify_stream");
    });
    const client = service.clients[0]!;

    client.emitNotification("不是 JSON");
    client.emitNotification(JSON.stringify({ recipientId: ME, event: "unknown", data: {} }));
    client.emitNotification(JSON.stringify({ recipientId: ME, event: "unread", data: { unreadCount: -1 } }));
    client.emitNotification(JSON.stringify({ recipientId: ME, event: "notification", data: { id: "x" } }));
    client.emitNotification(wireNotification(ME), "other_channel");
    expect(sink.chunks).toEqual([]);

    client.emitNotification(JSON.stringify({ recipientId: ME, event: "unread", data: { unreadCount: 0 } }));
    expect(sink.chunks).toEqual([frameOf("unread", { unreadCount: 0 })]);
  });

  it("心跳：按 env 周期发注释行；连接关闭后停止", async () => {
    vi.useFakeTimers();
    try {
      const { service } = makeService({ NOTIFY_STREAM_HEARTBEAT_MS: "1000" });
      const sink = new FakeSink();
      const connection = service.open(ME, sink);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sink.chunks).toEqual([": ping\n\n"]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(sink.chunks).toEqual([": ping\n\n", ": ping\n\n", ": ping\n\n"]);

      connection?.close();
      expect(sink.ended).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sink.chunks).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("轮询兜底：NOTIFY_STREAM_POLL_MS > 0 时按周期补 unread 角标（默认关不发）", async () => {
    vi.useFakeTimers();
    try {
      const { service, repository } = makeService({ NOTIFY_STREAM_POLL_MS: "500" });
      const sink = new FakeSink();
      service.open(ME, sink);
      repository.unread = 7;
      await vi.advanceTimersByTimeAsync(500);
      expect(repository.countUnreadCalls).toEqual([ME]);
      expect(sink.chunks).toEqual([frameOf("unread", { unreadCount: 7 })]);

      const closed = makeService();
      const quiet = new FakeSink();
      closed.service.open(OTHER, quiet);
      await vi.advanceTimersByTimeAsync(5000);
      expect(quiet.chunks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("优雅关闭：先发注释行再收尾、桥关闭；停机后拒新", async () => {
    const { service } = makeService();
    const mine = new FakeSink();
    const other = new FakeSink();
    service.open(ME, mine);
    service.open(OTHER, other);
    await vi.waitFor(() => {
      expect(service.clients).toHaveLength(1);
      expect(service.clients[0]?.queries).toContain("LISTEN notify_stream");
    });
    const client = service.clients[0]!;

    await service.onApplicationShutdown();
    expect(mine.chunks).toEqual([": server-shutdown\n\n"]);
    expect(other.chunks).toEqual([": server-shutdown\n\n"]);
    expect(mine.ended).toBe(1);
    expect(other.ended).toBe(1);
    expect(client.ended).toBe(1);
    expect(service.connectionCount()).toBe(0);
    expect(service.open(ME, new FakeSink())).toBeNull();
  });

  it("广播桥掉线：仍有活跃连接时自动重连；无连接不重试", async () => {
    vi.useFakeTimers();
    try {
      const { service } = makeService();
      const sink = new FakeSink();
      const connection = service.open(ME, sink);
      await flushMicrotasks();
      expect(service.clients[0]?.queries).toContain("LISTEN notify_stream");

      service.clients[0]!.errorHandler?.(new Error("connection reset"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(service.clients).toHaveLength(2);
      await flushMicrotasks();
      expect(service.clients[1]?.queries).toContain("LISTEN notify_stream");

      connection?.close();
      service.clients[1]!.errorHandler?.(new Error("again"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(service.clients).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("发布器：事务内 pg_notify（通道 notify_stream + 契约事件载荷）", async () => {
    const captured: SQL[] = [];
    const client = {
      execute: async (query: SQL) => {
        captured.push(query);
      },
    };
    const publisher = new NotifyStreamPublisher();
    await publisher.publish(client as never, { recipientId: ME, event: "unread", data: { unreadCount: 3 } });
    expect(captured).toHaveLength(1);

    const dialect = new PgDialect();
    const query = dialect.sqlToQuery(captured[0]!);
    expect(query.sql).toBe("select pg_notify($1, $2)");
    expect(query.params[0]).toBe("notify_stream");
    expect(JSON.parse(String(query.params[1]))).toEqual({ recipientId: ME, event: "unread", data: { unreadCount: 3 } });
  });
});
