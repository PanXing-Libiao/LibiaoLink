import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import { ProjectsController } from "../src/modules/project/project.controller.js";
import type { ProjectMemberService } from "../src/modules/project/project-member.service.js";
import type { ProjectGroupService } from "../src/modules/project/project-group.service.js";
import type { ProjectService } from "../src/modules/project/project.service.js";
import type { DictService } from "../src/modules/admin/index.js";
import type { ProjectAccessContext, ProjectManagerEligibilityService } from "../src/modules/permission/index.js";
import type { TranslateService } from "../src/modules/translate/index.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const ACCESS: ProjectAccessContext = { projectId: PROJECT_ID, member: true, projectManager: false, groupAccessLevel: "edit", accessLevel: "edit" };

class FakeDictService {
  calls: { name: string; actorId: string }[] = [];
  async createCustomDeliverableType(name: string, actorId: string): Promise<never> {
    this.calls.push({ name, actorId });
    return { type: "deliverableType", items: [], updatedAt: "2026-11-06T00:00:00.000Z" } as never;
  }
}

function makeController(): { controller: ProjectsController; dicts: FakeDictService } {
  const dicts = new FakeDictService();
  const controller = new ProjectsController(
    {} as ProjectService,
    {} as ProjectMemberService,
    {} as ProjectGroupService,
    {} as ProjectManagerEligibilityService,
    {} as TranslateService,
    dicts as unknown as DictService,
  );
  return { controller, dicts };
}

describe("项目内新增全站自定义成果类型（仅限项目编辑者）", () => {
  it("最终权限 view（即使上下文带项目经理关系标记）403 FORBIDDEN，且不写字典", async () => {
    const { controller, dicts } = makeController();
    await expect(
      controller.createDeliverableType(
        PROJECT_ID,
        { name: "竣工图" },
        { ...ACCESS, projectManager: true, groupAccessLevel: "view", accessLevel: "view" },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    } satisfies Partial<AppError>);
    expect(dicts.calls).toEqual([]);
  });

  it("项目编辑者新增：不要求项目经理关系，透传名称与当前账号", async () => {
    const { controller, dicts } = makeController();
    const result = await controller.createDeliverableType(
      PROJECT_ID,
      { name: "现场签证单" },
      ACCESS,
      ACTOR_ID,
    );
    expect(dicts.calls).toEqual([{ name: "现场签证单", actorId: ACTOR_ID }]);
    expect(result).toMatchObject({ type: "deliverableType" });
  });
});
