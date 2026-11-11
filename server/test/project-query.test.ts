import { describe, expect, it } from "vitest";
import type { ProjectScopeFilter } from "../src/modules/permission/index.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import { normalizeProjectName, ProjectQueryService } from "../src/modules/project/project-query.service.js";
import type { ProjectReferenceRow, ProjectRepository } from "../src/modules/project/project.repository.js";

const VISIBLE = "11111111-1111-4111-8111-111111111111";
const SAME_NAME = "22222222-2222-4222-8222-222222222222";
const HIDDEN = "99999999-9999-4999-8999-999999999999";
const ALICE = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

class FakePermissionService {
  scope: ProjectScopeFilter = { kind: "all" };

  async projectScope(): Promise<ProjectScopeFilter> {
    return this.scope;
  }
}

class FakeProjectRepository {
  rows: ProjectReferenceRow[] = [];
  scopes: ProjectScopeFilter[] = [];

  async listVisibleReferences(scope: ProjectScopeFilter): Promise<ProjectReferenceRow[]> {
    this.scopes.push(scope);
    if (scope.kind === "all") return this.rows;
    return this.rows.filter((row) => scope.ids.includes(row.id));
  }

  async findReferenceById(id: string): Promise<ProjectReferenceRow | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }
}

function makeService(rows: ProjectReferenceRow[], scope: ProjectScopeFilter = { kind: "all" }) {
  const permissions = new FakePermissionService();
  permissions.scope = scope;
  const projects = new FakeProjectRepository();
  projects.rows = rows;
  return {
    service: new ProjectQueryService(
      permissions as unknown as PermissionService,
      projects as unknown as ProjectRepository,
    ),
    permissions,
    projects,
  };
}

describe("ProjectQueryService（S1 项目编号 / 名称精确解析）", () => {
  it("项目名称按 NFKC → trim → 合并空白 → 小写归一化", () => {
    expect(normalizeProjectName("　Ｌｉｎｋ　  Data   Center　")).toBe("link data center");
  });

  it("编号精确命中并优先于同名项目", async () => {
    const { service } = makeService([
      { id: VISIBLE, code: "PRJ-001", name: "临港数据中心" },
      { id: SAME_NAME, code: "PRJ-008", name: "prj-001" },
    ]);

    const result = await service.lookup(ALICE, "PRJ-001");

    expect(result).toEqual({
      status: "unique",
      project: { id: VISIBLE, code: "PRJ-001", name: "临港数据中心" },
    });
  });

  it("名称归一化后精确命中；不做模糊搜索", async () => {
    const { service } = makeService([
      { id: VISIBLE, code: "PRJ-001", name: "Link  Data Center" },
    ]);

    await expect(service.lookup(ALICE, "　ｌｉｎｋ data　center ")).resolves.toEqual({
      status: "unique",
      project: { id: VISIBLE, code: "PRJ-001", name: "Link  Data Center" },
    });
    await expect(service.lookup(ALICE, "Link Data")).resolves.toEqual({ status: "not_found" });
  });

  it("可见范围内重名返回全部候选，按编号稳定排序", async () => {
    const { service } = makeService([
      { id: SAME_NAME, code: "PRJ-008", name: "临港数据中心" },
      { id: VISIBLE, code: "PRJ-001", name: "临港数据中心" },
    ]);

    const result = await service.lookup(ALICE, " 临港数据中心 ");

    expect(result).toEqual({
      status: "ambiguous",
      candidates: [
        { id: VISIBLE, code: "PRJ-001", name: "临港数据中心" },
        { id: SAME_NAME, code: "PRJ-008", name: "临港数据中心" },
      ],
    });
  });

  it("不可见项目不参与命中，也不造成重名", async () => {
    const { service } = makeService(
      [
        { id: VISIBLE, code: "PRJ-001", name: "临港数据中心" },
        { id: HIDDEN, code: "PRJ-009", name: "临港数据中心" },
      ],
      { kind: "ids", ids: [VISIBLE] },
    );

    const result = await service.lookup(ALICE, "临港数据中心");

    expect(result).toEqual({
      status: "unique",
      project: { id: VISIBLE, code: "PRJ-001", name: "临港数据中心" },
    });
  });

  it("群绑定项目只与绑定项目比对：同名其它项目不制造歧义", async () => {
    const { service } = makeService([
      { id: VISIBLE, code: "PRJ-001", name: "临港数据中心" },
      { id: SAME_NAME, code: "PRJ-008", name: "临港数据中心" },
    ]);

    await expect(service.matchesBoundProject(VISIBLE, "临港数据中心")).resolves.toBe(true);
    await expect(service.matchesBoundProject(VISIBLE, "PRJ-001")).resolves.toBe(true);
    await expect(service.matchesBoundProject(VISIBLE, "PRJ-008")).resolves.toBe(false);
    await expect(service.matchesBoundProject(VISIBLE, "其它项目")).resolves.toBe(false);
  });

  it("空输入与无命中均为 not_found；空可见集不查业务数据", async () => {
    const { service, projects } = makeService([], { kind: "ids", ids: [] });

    await expect(service.lookup(ALICE, "   ")).resolves.toEqual({ status: "not_found" });
    expect(projects.scopes).toEqual([]);
    await expect(service.lookup(ALICE, "不存在项目")).resolves.toEqual({ status: "not_found" });
  });
});
