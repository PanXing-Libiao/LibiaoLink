/**
 * 字典新增的按类型分权回归（C9-02 修订 · 2026-09-23 · Push 168）：
 * `POST /api/v1/dicts/{type}/items` —— **region 任何登录用户可增**（地区是全站共享的公共标签，
 * 非管理员新增同样全站可见、可在首页按它筛选）；**其余类型（projectType）仍 dict.manage**。
 * 不连库：控制器直接用替身注入（DictService / PermissionService），只验鉴权分支与调用顺序。
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type { DictItemCreateBody } from "@libiaolink/contracts";
import { DictsController } from "../src/modules/admin/dicts.controller.js";
import type { DictService } from "../src/modules/admin/dict.service.js";
import type { PermissionService } from "../src/modules/permission/index.js";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const REGION_BODY: DictItemCreateBody = { code: "东南亚", name: "东南亚", sort: 90, enabled: true, metadata: {} };

/** 替身：记录收到的 (type, body, actorId)，返回一个最小字典（控制器只透传）。 */
class FakeDictService {
  calls: { type: string; body: DictItemCreateBody; actorId: string }[] = [];
  async createItem(type: string, body: DictItemCreateBody, actorId: string): Promise<never> {
    this.calls.push({ type, body, actorId });
    return { type, items: [], updatedAt: "2026-09-23T00:00:00.000Z" } as never;
  }
}

/** 替身：无权限的账号 assertCan 抛 FORBIDDEN（与 PermissionService 同形）。 */
class FakePermissionService {
  calls: { actorId: string; key: string }[] = [];
  writableCalls: string[] = [];
  constructor(
    private readonly allowed: boolean,
    private readonly readOnly = false,
  ) {}
  async assertWritable(actorId: string): Promise<void> {
    this.writableCalls.push(actorId);
    if (this.readOnly) {
      throw new AppError("FORBIDDEN", "当前部门为只读，不能新增字典条目");
    }
  }
  async assertCan(actorId: string, key: string): Promise<void> {
    this.calls.push({ actorId, key });
    if (!this.allowed) {
      throw new AppError("FORBIDDEN", "无权限：" + key);
    }
  }
}

function makeController(allowed: boolean, readOnly = false): {
  controller: DictsController;
  dicts: FakeDictService;
  permission: FakePermissionService;
} {
  const dicts = new FakeDictService();
  const permission = new FakePermissionService(allowed, readOnly);
  const controller = new DictsController(
    dicts as unknown as DictService,
    permission as unknown as PermissionService,
  );
  return { controller, dicts, permission };
}

describe("字典新增按类型分权（C9-02 修订）", () => {
  it("region：普通账号（无 dict.manage）也能新增 —— 不做权限判定，直接落库", async () => {
    const { controller, dicts, permission } = makeController(false);
    await controller.createItem("region", REGION_BODY, ACTOR_ID);
    expect(permission.calls).toEqual([]);
    expect(dicts.calls).toEqual([{ type: "region", body: REGION_BODY, actorId: ACTOR_ID }]);
  });

  it("region：管理员同样不额外判定（同一写路径）", async () => {
    const { controller, dicts, permission } = makeController(true);
    await controller.createItem("region", REGION_BODY, ACTOR_ID);
    expect(permission.calls).toEqual([]);
    expect(dicts.calls).toHaveLength(1);
  });

  it("projectType：普通账号 403 FORBIDDEN，且不落库", async () => {
    const { controller, dicts, permission } = makeController(false);
    await expect(controller.createItem("projectType", REGION_BODY, ACTOR_ID)).rejects.toBeInstanceOf(AppError);
    expect(permission.calls).toEqual([{ actorId: ACTOR_ID, key: "dict.manage" }]);
    expect(dicts.calls).toEqual([]);
  });

  it("projectType：管理员按 dict.manage 放行", async () => {
    const { controller, dicts, permission } = makeController(true);
    await controller.createItem("projectType", REGION_BODY, ACTOR_ID);
    expect(permission.calls).toEqual([{ actorId: ACTOR_ID, key: "dict.manage" }]);
    expect(dicts.calls).toHaveLength(1);
  });

  it("部门只读：region / projectType 都在分类型判定前拒绝，且不落库", async () => {
    for (const type of ["region", "projectType"]) {
      const { controller, dicts, permission } = makeController(true, true);
      await expect(controller.createItem(type, REGION_BODY, ACTOR_ID)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(permission.writableCalls).toEqual([ACTOR_ID]);
      expect(permission.calls).toEqual([]);
      expect(dicts.calls).toEqual([]);
    }
  });

  it("未知类型：非管理员先撞 403（不泄漏类型是否存在），管理员才走到服务层 404", async () => {
    const denied = makeController(false);
    await expect(denied.controller.createItem("unknown", REGION_BODY, ACTOR_ID)).rejects.toBeInstanceOf(AppError);
    expect(denied.dicts.calls).toEqual([]);
    const allowed = makeController(true);
    await allowed.controller.createItem("unknown", REGION_BODY, ACTOR_ID);
    expect(allowed.dicts.calls).toHaveLength(1);
  });
});
