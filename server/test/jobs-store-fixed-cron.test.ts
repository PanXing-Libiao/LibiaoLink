/**
 * 系统固定 cron 任务注册门禁（不连库）：首次注册 / 幂等不变更 / pending 定义刷新 / failed、
 * done 复活并保留正确水位。管理员日报依赖该入口在每次 worker 启动时安全重跑。
 */
import { describe, expect, it } from "vitest";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import { JobsStore } from "../src/db/jobs.store.js";

interface JobFixture {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  cron: string | null;
  status: string;
  lastRunAt: Date | null;
}

class FakeFixedCronDb {
  readonly inserts: Record<string, unknown>[] = [];
  readonly updates: Record<string, unknown>[] = [];
  insertResult: Array<{ id: number }> = [];

  constructor(public rows: JobFixture[] = []) {}

  async transaction<T>(work: (tx: FakeFixedCronDb) => Promise<T>): Promise<T> {
    return work(this);
  }

  insert() {
    return {
      values: (value: Record<string, unknown>) => {
        this.inserts.push(value);
        return {
          onConflictDoNothing: () => ({
            returning: async () => this.insertResult,
          }),
        };
      },
    };
  }

  select() {
    return {
      from: () => ({
        where: () => ({
          limit: async () => this.rows,
        }),
      }),
    };
  }

  update() {
    return {
      set: (value: Record<string, unknown>) => ({
        where: async () => {
          this.updates.push(value);
        },
      }),
    };
  }
}

function store(fake: FakeFixedCronDb): JobsStore {
  return new JobsStore({ db: fake as unknown as DbClient } as unknown as DatabaseService);
}

const RUN_AT = new Date("2026-10-29T00:00:00.000Z");
const INPUT = {
  kind: "outbox.alert-digest",
  dedupeKey: "system:outbox-alert-digest",
  cron: "0 8 * * *",
  runAt: RUN_AT,
  payload: {},
};

function row(overrides: Partial<JobFixture> = {}): JobFixture {
  return {
    id: 9,
    kind: INPUT.kind,
    payload: {},
    cron: INPUT.cron,
    status: "pending",
    lastRunAt: null,
    ...overrides,
  };
}

describe("JobsStore.ensureFixedCronJob（系统固定 cron 注册）", () => {
  it("首次注册：插入 pending 与固定去重键，run_at = 当天 08:00", async () => {
    const fake = new FakeFixedCronDb();
    fake.insertResult = [{ id: 9 }];

    await expect(store(fake).ensureFixedCronJob(INPUT)).resolves.toBe("inserted");
    expect(fake.inserts).toEqual([
      {
        kind: INPUT.kind,
        payload: {},
        cron: INPUT.cron,
        runAt: RUN_AT,
        status: "pending",
        dedupeKey: INPUT.dedupeKey,
      },
    ]);
    expect(fake.updates).toHaveLength(0);
  });

  it("pending 且定义一致：unchanged，不重置运行水位", async () => {
    const fake = new FakeFixedCronDb([row({ lastRunAt: new Date("2026-10-28T00:00:00.000Z") })]);

    await expect(store(fake).ensureFixedCronJob(INPUT)).resolves.toBe("unchanged");
    expect(fake.updates).toHaveLength(0);
  });

  it("pending 定义变化：只刷新 kind / cron / payload，不清空水位与状态", async () => {
    const fake = new FakeFixedCronDb([row({ kind: "old.kind", lastRunAt: new Date("2026-10-28T00:00:00.000Z") })]);

    await expect(store(fake).ensureFixedCronJob(INPUT)).resolves.toBe("updated");
    expect(fake.updates[0]).toMatchObject({ kind: INPUT.kind, payload: {}, cron: INPUT.cron });
    expect(fake.updates[0]).not.toHaveProperty("runAt");
    expect(fake.updates[0]).not.toHaveProperty("lastRunAt");
    expect(fake.updates[0]).not.toHaveProperty("status");
  });

  it("failed 复活：恢复 pending、重置 attempts / error / lock，保留 last_run_at 以补当天窗口", async () => {
    const previousRun = new Date("2026-10-28T00:05:00.000Z");
    const fake = new FakeFixedCronDb([row({ status: "failed", lastRunAt: previousRun })]);

    await expect(store(fake).ensureFixedCronJob(INPUT)).resolves.toBe("reactivated");
    expect(fake.updates[0]).toMatchObject({
      status: "pending",
      runAt: RUN_AT,
      lastRunAt: previousRun,
      attempts: 0,
      lastError: null,
      lockedAt: null,
    });
  });

  it("done 复活：last_run_at 落在本次 run_at 前 1ms，确保当天 08:00 命中一次", async () => {
    const fake = new FakeFixedCronDb([row({ status: "done", lastRunAt: new Date("2026-10-27T00:00:00.000Z") })]);

    await expect(store(fake).ensureFixedCronJob(INPUT)).resolves.toBe("reactivated");
    expect(fake.updates[0]?.["lastRunAt"]).toEqual(new Date(RUN_AT.getTime() - 1));
  });
});
