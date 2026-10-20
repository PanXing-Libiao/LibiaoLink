import { describe, expect, it } from "vitest";
import { ClockService } from "../src/common/clock/clock.service.js";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type {
  AdvisoryLock,
  ClaimDueJobsInput,
  FinishJobRunInput,
  JobRow,
  JobsStore,
  MarkJobFailureInput,
  RecordSkippedInput,
} from "../src/db/jobs.store.js";
import { JobScheduler, type OutboxJobHandler } from "../src/outbox/scheduler.js";

/**
 * S7-3 调度器门禁（不连库）：单活锁 / 到期领取 / 补发窗口 / 产出与推进同事务 / 失败累计 / 无生产者只存不跑。
 * 真机语义（杀 worker 不丢、重复领取不重发、补发与状态回退再生落库）由 s7-3-scheduler-replay.mjs 覆盖。
 */

const NOW = new Date("2026-09-28T02:00:00Z");
/** 假事务句柄：断言 handler 拿到的 tx 与 finishRun / recordSkipped 收到的 client 是同一个。 */
const TX = { marker: "fake-transaction" };

const ENV = {
  WORKER_ID: "scheduler-test",
  OUTBOX_STALE_MS: 600000,
  OUTBOX_SCHEDULER_BATCH_LIMIT: 10,
  OUTBOX_SCHEDULER_MAX_ATTEMPTS: 3,
  OUTBOX_SCHEDULER_CATCHUP_MAX_DAYS: 7,
  OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK: 50,
} as unknown as Env;

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    kind: "demo.kind",
    payload: {},
    cron: "0 8 * * *",
    runAt: new Date("2026-09-28T00:00:00Z"),
    lastRunAt: null,
    status: "pending",
    attempts: 0,
    lastError: null,
    lockedBy: null,
    lockedAt: null,
    dedupeKey: null,
    ...overrides,
  };
}

class FakeJobsStore {
  readonly lockNames: string[] = [];
  lockResult: AdvisoryLock | null = { release: async (): Promise<void> => {} };
  readonly claims: ClaimDueJobsInput[] = [];
  due: JobRow[] = [];
  readonly released: number[] = [];
  readonly finished: FinishJobRunInput[] = [];
  readonly finishClients: unknown[] = [];
  readonly skipped: RecordSkippedInput[] = [];
  readonly skippedClients: unknown[] = [];
  readonly failures: MarkJobFailureInput[] = [];

  async tryAdvisoryLock(lockName: string): Promise<AdvisoryLock | null> {
    this.lockNames.push(lockName);
    return this.lockResult;
  }

  async claimDue(input: ClaimDueJobsInput): Promise<JobRow[]> {
    this.claims.push(input);
    const rows = this.due;
    this.due = [];
    return rows;
  }

  async releaseClaim(jobId: number): Promise<void> {
    this.released.push(jobId);
  }

  async finishRun(client: unknown, input: FinishJobRunInput): Promise<void> {
    this.finishClients.push(client);
    this.finished.push(input);
  }

  async recordSkipped(client: unknown, input: RecordSkippedInput): Promise<void> {
    this.skippedClients.push(client);
    this.skipped.push(input);
  }

  async markFailure(input: MarkJobFailureInput): Promise<void> {
    this.failures.push(input);
  }
}

function makeScheduler(
  handlers: Map<string, OutboxJobHandler> = new Map(),
  envOverrides: Partial<Env> = {},
): { scheduler: JobScheduler; store: FakeJobsStore } {
  const store = new FakeJobsStore();
  const clock = new ClockService();
  clock.setSource(() => NOW);
  const config = new AppConfig({ ...ENV, ...envOverrides } as Env);
  const database = {
    db: {
      transaction: async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => callback(TX),
    },
  } as unknown as DatabaseService;
  const scheduler = new JobScheduler(database, store as unknown as JobsStore, handlers, clock, config);
  return { scheduler, store };
}

describe("JobScheduler.tickOnce（S7-3 调度 / 补发 / 单活）", () => {
  it("注册表为空：只存不跑（不占锁、不触库）", async () => {
    const h = makeScheduler();

    const stats = await h.scheduler.tickOnce();

    expect(stats).toEqual({ lockAcquired: false, claimed: 0, executed: 0, failed: 0, unbound: 0, produced: 0 });
    expect(h.store.lockNames).toHaveLength(0);
    expect(h.store.claims).toHaveLength(0);
  });

  it("未取得单活锁：本 tick 跳过（其它实例正在调度）", async () => {
    const h = makeScheduler(new Map([["demo.kind", { run: async () => ({}) }]]));
    h.store.lockResult = null;

    const stats = await h.scheduler.tickOnce();

    expect(stats).toEqual({ lockAcquired: false, claimed: 0, executed: 0, failed: 0, unbound: 0, produced: 0 });
    expect(h.store.lockNames).toEqual(["libiaolink:outbox:scheduler"]);
    expect(h.store.claims).toHaveLength(0);
  });

  it("cron 补发：窗口 (last_run_at, now] + 产出与 last_run_at 推进同事务", async () => {
    const contexts: { fireTimes: readonly Date[]; tx: unknown }[] = [];
    const h = makeScheduler(
      new Map([
        [
          "demo.kind",
          {
            run: async (context) => {
              contexts.push({ fireTimes: context.fireTimes, tx: context.tx });
              return { produced: 3, note: "补发 2 次触发" };
            },
          },
        ],
      ]),
    );
    h.store.due = [
      makeJob({ lastRunAt: new Date("2026-09-26T00:30:00Z"), runAt: new Date("2026-09-28T00:00:00Z") }),
    ];

    const stats = await h.scheduler.tickOnce();

    expect(stats).toEqual({ lockAcquired: true, claimed: 1, executed: 1, failed: 0, unbound: 0, produced: 3 });
    expect(h.store.claims[0]).toEqual({ limit: 10, staleAfterMs: 600000, workerId: "scheduler-test" });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.fireTimes.map((time) => time.toISOString())).toEqual([
      "2026-09-27T00:00:00.000Z",
      "2026-09-28T00:00:00.000Z",
    ]);
    const finished = h.store.finished[0]!;
    expect(finished).toMatchObject({
      jobId: 1,
      kind: "demo.kind",
      fireCount: 2,
      produced: 3,
      note: "补发 2 次触发",
    });
    expect(finished.windowFrom.toISOString()).toBe("2026-09-26T00:30:00.000Z");
    expect(finished.windowTo.toISOString()).toBe(NOW.toISOString());
    expect(finished.lastRunAt.toISOString()).toBe(NOW.toISOString());
    expect(finished.nextRunAt?.toISOString()).toBe("2026-09-29T00:00:00.000Z");
    // 同事务：handler 的 tx 与 finishRun 收到的 client 是同一个（产出与推进原子提交）
    expect(h.store.finishClients[0]).toBe(contexts[0]!.tx);
    expect(h.store.skipped).toHaveLength(0);
    expect(h.store.released).toHaveLength(0);
    expect(h.store.failures).toHaveLength(0);
  });

  it("从未执行（last_run_at null）：窗口从首个应执行时刻前 1ms 起，首触发不丢", async () => {
    const fires: string[][] = [];
    const h = makeScheduler(
      new Map([
        [
          "demo.kind",
          {
            run: async (context) => {
              fires.push(context.fireTimes.map((time) => time.toISOString()));
              return { produced: 2 };
            },
          },
        ],
      ]),
    );
    h.store.due = [makeJob({ runAt: new Date("2026-09-27T00:00:00Z") })];

    const stats = await h.scheduler.tickOnce();

    expect(stats.executed).toBe(1);
    expect(fires).toEqual([["2026-09-27T00:00:00.000Z", "2026-09-28T00:00:00.000Z"]]);
    expect(h.store.finished[0]!.windowFrom.toISOString()).toBe("2026-09-26T23:59:59.999Z");
  });

  it("一次性任务（cron null）：执行后置 done（nextRunAt null），窗口 = [runAt, now]", async () => {
    const fires: string[][] = [];
    const h = makeScheduler(
      new Map([
        [
          "demo.kind",
          {
            run: async (context) => {
              fires.push(context.fireTimes.map((time) => time.toISOString()));
              return { produced: 1 };
            },
          },
        ],
      ]),
    );
    h.store.due = [makeJob({ cron: null, runAt: new Date("2026-09-27T10:00:00Z") })];

    const stats = await h.scheduler.tickOnce();

    expect(stats.executed).toBe(1);
    expect(fires).toEqual([["2026-09-27T10:00:00.000Z"]]);
    expect(h.store.finished[0]!.nextRunAt).toBeNull();
    expect(h.store.finished[0]!.windowFrom.toISOString()).toBe("2026-09-27T09:59:59.999Z");
  });

  it("无生产者 kind：只存不跑（releaseClaim、窗口不推进），同批其余任务照常", async () => {
    const h = makeScheduler(new Map([["other.kind", { run: async () => ({}) }]]));
    h.store.due = [makeJob({ kind: "unbound.kind" }), makeJob({ id: 2, kind: "other.kind" })];

    const stats = await h.scheduler.tickOnce();

    expect(stats).toMatchObject({ claimed: 2, executed: 1, unbound: 1, failed: 0 });
    expect(h.store.released).toEqual([1]);
    expect(h.store.finished.map((item) => item.jobId)).toEqual([2]);
  });

  it("handler 抛错：attempts 累计、不推进窗口（重试由下个 tick 领取）", async () => {
    const h = makeScheduler(
      new Map([
        [
          "demo.kind",
          {
            run: async () => {
              throw new Error("处理器炸了");
            },
          },
        ],
      ]),
    );
    h.store.due = [makeJob({ attempts: 1 })];

    const stats = await h.scheduler.tickOnce();

    expect(stats).toMatchObject({ claimed: 1, executed: 0, failed: 1, produced: 0 });
    expect(h.store.finished).toHaveLength(0);
    expect(h.store.failures).toHaveLength(1);
    expect(h.store.failures[0]).toMatchObject({ jobId: 1, attempts: 2, maxAttempts: 3, error: "处理器炸了" });
  });

  it("超补发跨度：窗口收窄到上限处 + recordSkipped 留痕（超出区间不补发）", async () => {
    const h = makeScheduler(new Map([["demo.kind", { run: async () => ({ produced: 1 }) }]]));
    h.store.due = [makeJob({ lastRunAt: new Date("2026-08-01T00:00:00Z") })];

    const stats = await h.scheduler.tickOnce();

    expect(stats.produced).toBe(1);
    const finished = h.store.finished[0]!;
    expect(finished.windowFrom.toISOString()).toBe("2026-09-21T02:00:00.000Z"); // NOW - 7d
    expect(finished.fireCount).toBe(7);
    expect(h.store.skipped).toHaveLength(1);
    expect(h.store.skipped[0]).toMatchObject({ jobId: 1, kind: "demo.kind" });
    expect(h.store.skipped[0]!.windowFrom.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(h.store.skipped[0]!.windowTo.toISOString()).toBe("2026-09-21T02:00:00.000Z");
    expect(h.store.skipped[0]!.note).toMatch(/补发跨度上限/);
    expect(h.store.skippedClients[0]).toBe(h.store.finishClients[0]);
  });

  it("不可能 cron（无下一触发时刻）：按失败收敛（不执行 handler）", async () => {
    let called = 0;
    const h = makeScheduler(
      new Map([
        [
          "demo.kind",
          {
            run: async () => {
              called += 1;
              return {};
            },
          },
        ],
      ]),
    );
    h.store.due = [makeJob({ cron: "0 0 31 2 *", runAt: new Date("2026-02-01T00:00:00Z") })];

    const stats = await h.scheduler.tickOnce();

    expect(stats).toMatchObject({ claimed: 1, executed: 0, failed: 1 });
    expect(called).toBe(0);
    expect(h.store.failures[0]!.error).toMatch(/无下一触发时刻/);
    expect(h.store.finished).toHaveLength(0);
  });

  it("窗口触顶（maxWindowsPerTick）：水位停在本轮最后处理的窗口 + run_at=now 顺延（不越过未处理窗口）", async () => {
    const fires: string[][] = [];
    const h = makeScheduler(
      new Map([
        [
          "demo.kind",
          {
            run: async (context) => {
              fires.push(context.fireTimes.map((time) => time.toISOString()));
              return { produced: context.fireTimes.length };
            },
          },
        ],
      ]),
      { OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK: 3 },
    );
    h.store.due = [makeJob({ lastRunAt: new Date("2026-09-23T00:00:00Z"), runAt: new Date("2026-09-23T00:00:00Z") })];

    const stats = await h.scheduler.tickOnce();

    expect(stats).toMatchObject({ claimed: 1, executed: 1, produced: 3 });
    expect(fires).toEqual([
      ["2026-09-24T00:00:00.000Z", "2026-09-25T00:00:00.000Z", "2026-09-26T00:00:00.000Z"],
    ]);
    const finished = h.store.finished[0]!;
    expect(finished.lastRunAt.toISOString()).toBe("2026-09-26T00:00:00.000Z");
    expect(finished.windowTo.toISOString()).toBe("2026-09-26T00:00:00.000Z");
    expect(finished.nextRunAt?.toISOString()).toBe(NOW.toISOString());
    expect(finished.note).toMatch(/窗口触顶/);
    expect(h.store.skipped).toHaveLength(0);
  });

  it("触顶顺延后下一轮追平：last_run_at=now、run_at=下一触发（不越过只在触顶轮生效）", async () => {
    const fires: string[][] = [];
    const h = makeScheduler(
      new Map([
        [
          "demo.kind",
          {
            run: async (context) => {
              fires.push(context.fireTimes.map((time) => time.toISOString()));
              return { produced: context.fireTimes.length };
            },
          },
        ],
      ]),
      { OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK: 3 },
    );
    h.store.due = [makeJob({ lastRunAt: new Date("2026-09-23T00:00:00Z"), runAt: new Date("2026-09-23T00:00:00Z") })];
    await h.scheduler.tickOnce();
    const first = h.store.finished[0]!;

    h.store.due = [makeJob({ lastRunAt: first.lastRunAt, runAt: first.nextRunAt! })];
    const stats = await h.scheduler.tickOnce();

    expect(stats).toMatchObject({ executed: 1, produced: 2 });
    expect(fires[1]).toEqual(["2026-09-27T00:00:00.000Z", "2026-09-28T00:00:00.000Z"]);
    const second = h.store.finished[1]!;
    expect(second.lastRunAt.toISOString()).toBe(NOW.toISOString());
    expect(second.windowTo.toISOString()).toBe(NOW.toISOString());
    expect(second.nextRunAt?.toISOString()).toBe("2026-09-29T00:00:00.000Z");
    expect(second.note).toBeNull();
  });
});
