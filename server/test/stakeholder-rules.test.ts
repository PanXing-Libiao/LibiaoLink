/**
 * j6 干系人策略纯函数回归（A5-03 / A5-04）：记录级可见集规格、列表过滤 / 排序解析、关键词谓词。
 * 字段级脱敏的服务层回归见 test/stakeholder-service.test.ts（验收项「字段级脱敏用例通过」）。
 */
import { describe, expect, it } from "vitest";
import {
  buildStakeholderFilter,
  isStakeholderProjectFilterVisible,
  matchesKeyword,
  parseStakeholderSort,
  stakeholderVisibility,
} from "../src/modules/stakeholder/index.js";

const PROJECT = "22222222-2222-4222-8222-222222222222";

describe("stakeholderVisibility（项目级记录）", () => {
  it("项目可见集为 all（管理员）→ 台账全量", () => {
    expect(stakeholderVisibility({ kind: "all" })).toEqual({ kind: "all" });
  });

  it("项目可见集为 ids → restricted 只保留可见项目", () => {
    const visibility = stakeholderVisibility({ kind: "ids", ids: [PROJECT] });
    expect(visibility).toEqual({ kind: "restricted", projectIds: [PROJECT] });
  });

  it("无可见项目 → 空可见集，不按录入人兜底", () => {
    const visibility = stakeholderVisibility({ kind: "ids", ids: [] });
    expect(visibility).toEqual({ kind: "restricted", projectIds: [] });
  });

  it("可见集 ids 为副本：改动不影响入参", () => {
    const ids = [PROJECT];
    const visibility = stakeholderVisibility({ kind: "ids", ids });
    if (visibility.kind !== "restricted") throw new Error("应为 restricted");
    visibility.projectIds.push("x");
    expect(ids).toEqual([PROJECT]);
  });
});

describe("buildStakeholderFilter（过滤解析）", () => {
  it("空查询 → 三个条件全为 null；关键词去空白", () => {
    expect(buildStakeholderFilter({ page: 1, limit: 50 })).toEqual({ keyword: null, companyTypes: null, projectId: null });
    expect(buildStakeholderFilter({ page: 1, limit: 50, q: "   " })).toEqual({ keyword: null, companyTypes: null, projectId: null });
    expect(buildStakeholderFilter({ page: 1, limit: 50, q: " 张 " }).keyword).toBe("张");
  });

  it("公司分类多值逗号分隔；非法值 400", () => {
    const filter = buildStakeholderFilter({ page: 1, limit: 50, "filter[companyType]": "customer,supplier" });
    expect(filter.companyTypes).toEqual(["customer", "supplier"]);
    expect(() => buildStakeholderFilter({ page: 1, limit: 50, "filter[companyType]": "customer,unknown" })).toThrow(/非法公司分类/);
  });

  it("项目筛选原样透传（uuid 由契约校验）；无权项目筛选不可用", () => {
    const filter = buildStakeholderFilter({ page: 1, limit: 50, "filter[projectId]": PROJECT });
    expect(filter.projectId).toBe(PROJECT);
    expect(isStakeholderProjectFilterVisible(filter, { kind: "restricted", projectIds: [PROJECT] })).toBe(true);
    expect(isStakeholderProjectFilterVisible(filter, { kind: "restricted", projectIds: [] })).toBe(false);
  });
});

describe("parseStakeholderSort（排序白名单）", () => {
  it("缺省 updatedAt:desc（最近更新在前）", () => {
    expect(parseStakeholderSort(undefined)).toEqual([{ field: "updatedAt", direction: "desc" }]);
    expect(parseStakeholderSort("")).toEqual([{ field: "updatedAt", direction: "desc" }]);
  });

  it("多字段与方向", () => {
    expect(parseStakeholderSort("name:asc,createdAt:desc")).toEqual([
      { field: "name", direction: "asc" },
      { field: "createdAt", direction: "desc" },
    ]);
  });

  it("不在白名单的字段 / 方向 → 400", () => {
    expect(() => parseStakeholderSort("phone:asc")).toThrow(/白名单/);
    expect(() => parseStakeholderSort("name:up")).toThrow(/asc \/ desc/);
  });
});

describe("matchesKeyword（与仓储同口径）", () => {
  it("姓名 / 公司 / 职务任一命中；大小写不敏感", () => {
    const row = { name: "Christian Winkler", company: "ACME Ltd", title: "项目经理" };
    expect(matchesKeyword(row, "christian")).toBe(true);
    expect(matchesKeyword(row, "acme")).toBe(true);
    expect(matchesKeyword(row, "经理")).toBe(true);
    expect(matchesKeyword(row, "nobody")).toBe(false);
  });

  it("空公司与空职务不参与命中", () => {
    expect(matchesKeyword({ name: "张三", company: null, title: null }, "acme")).toBe(false);
  });
});
