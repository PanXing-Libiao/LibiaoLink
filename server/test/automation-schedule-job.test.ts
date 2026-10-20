/**
 * M5-06-1A 一规则一 job reconcile 门禁（不连库）：新增 / 更新 / 停用 / 重新启用 / 不变更。
 * 真表唯一键与 seed 侧 reconcile 见 scripts/m5-06-1a-replay.mjs。
 */
import { describe, expect, it } from "vitest";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import { JobsStore } from "../src/db/jobs.store.js";

interface JobFixture {
  id: number;
  payload: Record<string, unknown>;
  cron: string | null;
  status: string;
}

class FakeJobsDb {
  constructor(public rows: JobFixture[] = []) {}
  readonly inserts: Record<string, unknown>[] = [];
  readonly updates: Record<string, unknown>[] = [];

  select() {
    return {
      from: () => ({
        where: () => ({
          limit: async () => this.rows,
        }),
      }),
    };
  }

  insert() {
    return {
      values: async (value: Record<string, unknown>) => {
        this.inserts.push(value);
      },
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

function store(fake: FakeJobsDb): JobsStore {
  return new JobsStore({ db: fake as unknown as DbClient } as unknown as DatabaseService);
}

const NOW = new Date("2026-10-20T02:00:00Z");
const INPUT = { ruleCode: "R02", ruleVersion: 1, cron: "0 9 * * *", enabled: true, now: NOW };

describe("JobsStore.reconcileAutomationScheduleJob（一规则一 job）", () => {
  it("新启用规则：插入 pending，run_at / last_run_at = now（不补发启用前窗口）", async () => {
    const fake = new FakeJobsDb();
    await expect(store(fake).reconcileAutomationScheduleJob(fake as unknown as DbClient, INPUT)).resolves.toBe("inserted");
    expect(fake.inserts).toEqual([
      {
        kind: "automation-schedule.job",
        payload: { ruleCode: "R02", ruleVersion: 1 },
        cron: "0 9 * * *",
        runAt: NOW,
        lastRunAt: NOW,
        status: "pending",
        dedupeKey: "automation-schedule:R02",
      },
    ]);
  });

  it("新停用规则：插入 done（不创建可执行窗口）", async () => {
    const fake = new FakeJobsDb();
    await store(fake).reconcileAutomationScheduleJob(fake as unknown as DbClient, { ...INPUT, enabled: false });
    expect(fake.inserts[0]?.status).toBe("done");
  });

  it("done 后重新启用：pending、窗口重置、失败计数清零", async () => {
    const fake = new FakeJobsDb([{ id: 9, payload: { ruleCode: "R02", ruleVersion: 1 }, cron: "0 9 * * *", status: "done" }]);
    await expect(store(fake).reconcileAutomationScheduleJob(fake as unknown as DbClient, INPUT)).resolves.toBe("reactivated");
    expect(fake.updates[0]).toMatchObject({
      status: "pending",
      runAt: NOW,
      lastRunAt: NOW,
      attempts: 0,
      lastError: null,
      lockedAt: null,
    });
  });

  it("pending 且 payload / cron 变化：只刷新定义，不重置窗口与状态", async () => {
    const fake = new FakeJobsDb([{ id: 9, payload: { ruleCode: "R02", ruleVersion: 1 }, cron: "0 9 * * *", status: "pending" }]);
    await expect(
      store(fake).reconcileAutomationScheduleJob(fake as unknown as DbClient, { ...INPUT, ruleVersion: 2, cron: "5 9 * * *" }),
    ).resolves.toBe("updated");
    expect(fake.updates[0]).toEqual({ payload: { ruleCode: "R02", ruleVersion: 2 }, cron: "5 9 * * *", updatedAt: expect.anything() });
    expect(fake.updates[0]).not.toHaveProperty("runAt");
    expect(fake.updates[0]).not.toHaveProperty("status");
  });

  it("停用：job 置 done，保留行与历史窗口", async () => {
    const fake = new FakeJobsDb([{ id: 9, payload: { ruleCode: "R02", ruleVersion: 1 }, cron: "0 9 * * *", status: "pending" }]);
    await expect(
      store(fake).reconcileAutomationScheduleJob(fake as unknown as DbClient, { ...INPUT, enabled: false }),
    ).resolves.toBe("disabled");
    expect(fake.updates[0]).toMatchObject({ status: "done", lockedAt: null });
    expect(fake.updates[0]).not.toHaveProperty("runAt");
  });

  it("完全一致：unchanged，不写库", async () => {
    const fake = new FakeJobsDb([{ id: 9, payload: { ruleCode: "R02", ruleVersion: 1 }, cron: "0 9 * * *", status: "pending" }]);
    await expect(store(fake).reconcileAutomationScheduleJob(fake as unknown as DbClient, INPUT)).resolves.toBe("unchanged");
    expect(fake.updates).toHaveLength(0);
  });
});
