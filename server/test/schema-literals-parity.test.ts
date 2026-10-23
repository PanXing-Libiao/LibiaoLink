/**
 * 库侧枚举字面量 ↔ 契约枚举一致性（M4-05 · 数据层守卫）。
 * M4-05 一次扩两值：preview（D2-07）+ download（Push 160 定案 · A4-10）—— 契约先入、库侧值集随本片补齐，
 * 故此处专门守「两值都在、顺序与契约一致」。M2-06（Push 168）增补：视图范围（A1-03）与关注对象类型（A1-15）。
 * check:db-schema 只比对 CHECK 约束「名字」，不比取值 —— 枚举扩值时最容易漏的就是「契约加了、库侧 literals 没加」
 * （或反向），而这类漂移只在写库时才炸。本测试对三类值集逐值比对（顺序也一致，便于人工核对）。
 * 不连库：纯常量比对。
 */
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  FOLLOW_OBJECT_TYPES,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  PREVIEW_STATUSES,
  PREVIEW_TARGETS,
  VIEW_SCOPES,
} from "@libiaolink/contracts";
import {
  AUDIT_ACTION_KEYS,
  FOLLOW_OBJECT_TYPE_KEYS,
  NOTIFICATION_STATUS_KEYS,
  NOTIFICATION_TYPE_KEYS,
  PREVIEW_STATUS_KEYS,
  PREVIEW_TARGET_KEYS,
  VIEW_SCOPE_KEYS,
} from "../src/db/schema/literals.js";

describe("库侧枚举字面量与契约一致（schema literals ↔ contracts）", () => {
  it("审计动作：AUDIT_ACTION_KEYS = AUDIT_ACTIONS（含 visit / preview / download）", () => {
    expect([...AUDIT_ACTION_KEYS]).toEqual([...AUDIT_ACTIONS]);
  });

  it("扩值：archive（M7-04）/ visit / preview / download 均在库侧值集内，且顺序紧随 rollback", () => {
    const keys: readonly string[] = [...AUDIT_ACTION_KEYS];
    expect(keys.slice(keys.indexOf("rollback") + 1, keys.indexOf("deny"))).toEqual(["archive", "visit", "preview", "download"]);
  });

  it("预览渲染通道：PREVIEW_TARGET_KEYS = PREVIEW_TARGETS", () => {
    expect([...PREVIEW_TARGET_KEYS]).toEqual([...PREVIEW_TARGETS]);
  });

  it("预览产物状态：PREVIEW_STATUS_KEYS = PREVIEW_STATUSES", () => {
    expect([...PREVIEW_STATUS_KEYS]).toEqual([...PREVIEW_STATUSES]);
  });

  it("视图范围：VIEW_SCOPE_KEYS = VIEW_SCOPES（M2-06 · A1-03 · Push 168）", () => {
    expect([...VIEW_SCOPE_KEYS]).toEqual([...VIEW_SCOPES]);
  });

  it("关注对象类型：FOLLOW_OBJECT_TYPE_KEYS = FOLLOW_OBJECT_TYPES（M2-06 · A1-15 · Push 168）", () => {
    expect([...FOLLOW_OBJECT_TYPE_KEYS]).toEqual([...FOLLOW_OBJECT_TYPES]);
  });

  it("通知类型：NOTIFICATION_TYPE_KEYS = NOTIFICATION_TYPES（S7-4 · C5-02）", () => {
    expect([...NOTIFICATION_TYPE_KEYS]).toEqual([...NOTIFICATION_TYPES]);
  });

  it("通知状态：NOTIFICATION_STATUS_KEYS = NOTIFICATION_STATUSES（S7-4 · C5-01）", () => {
    expect([...NOTIFICATION_STATUS_KEYS]).toEqual([...NOTIFICATION_STATUSES]);
  });
});
