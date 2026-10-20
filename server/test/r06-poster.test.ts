/**
 * R06 动态海报回归：周期口径（进行中 = 计划周期，完成 = 实际历时）、按期率、
 * 黄黑品牌版分流、900x1350 PNG 输出与任务按期判定。字体默认使用仓库内思源宋体资产。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCompletedTaskOnTime } from "../src/modules/notify/notify.group.repository.js";
import {
  buildR06PosterMetrics,
  renderR06Poster,
  shouldUseR06BrandPoster,
  type R06PosterView,
} from "../src/modules/notify/r06.poster.js";

const VIEW: R06PosterView = {
  projectCode: "LBGW-20260331-1459",
  projectName: "UK-VANILLA-AIRROB",
  status: "active",
  managers: ["贾海洋"],
  participants: ["贾海洋", "张亚庆", "高云", "赵纯德", "史建明", "余仕铭", "王瑞宸", "朱成荣", "董伊涛", "陈建波", "何玉斓"],
  taskTotal: 44,
  taskDone: 28,
  onTimeDone: 27,
  startDate: "2026-05-15",
  plannedEnd: "2026-11-08",
  completedAt: new Date("2026-10-20T04:00:00.000Z"),
};

describe("buildR06PosterMetrics（R06 动态海报口径）", () => {
  it("进行中：计划周期 = 计划结束 − 首个计划开始；按期率 = 按时完成 / 已完成", () => {
    expect(buildR06PosterMetrics(VIEW)).toMatchObject({
      plannedDays: 177,
      elapsedDays: 158,
      rate: 96,
      rateText: "96",
      rateLabel: "已完成任务按期",
      allTasksDone: false,
    });
  });

  it("已完成：全部任务完成时标签切换为按时交付", () => {
    const metrics = buildR06PosterMetrics({ ...VIEW, taskDone: 44, onTimeDone: 44 });
    expect(metrics).toMatchObject({ rate: 100, rateLabel: "按时交付", allTasksDone: true });
  });

  it("无任务：显示占位符，不除零", () => {
    expect(buildR06PosterMetrics({ ...VIEW, taskTotal: 0, taskDone: 0, onTimeDone: 0 })).toMatchObject({
      rate: 0,
      rateText: "—",
      rateLabel: "暂无任务",
      allTasksDone: false,
    });
  });

  it("缺少计划结束日：计划周期回退实际历时", () => {
    expect(buildR06PosterMetrics({ ...VIEW, plannedEnd: null }).plannedDays).toBe(158);
  });
});

describe("shouldUseR06BrandPoster（黄黑品牌海报分流）", () => {
  it("仅当项目已完成且全部任务完成、全部按期时启用", () => {
    expect(shouldUseR06BrandPoster({ status: "done", taskTotal: 24, taskDone: 24, onTimeDone: 24 })).toBe(true);
    expect(shouldUseR06BrandPoster({ status: "done", taskTotal: 24, taskDone: 24, onTimeDone: 23 })).toBe(false);
    expect(shouldUseR06BrandPoster({ status: "done", taskTotal: 24, taskDone: 23, onTimeDone: 23 })).toBe(false);
    expect(shouldUseR06BrandPoster({ status: "done", taskTotal: 0, taskDone: 0, onTimeDone: 0 })).toBe(false);
    expect(shouldUseR06BrandPoster({ status: "active", taskTotal: 24, taskDone: 24, onTimeDone: 24 })).toBe(false);
  });
});

describe("R06 品牌海报资产", () => {
  it("Logo 使用显式品牌黄填充，避免 Canvas 丢失 SVG 类样式", () => {
    const logo = readFileSync(new URL("../assets/r06-brand-logo.svg", import.meta.url), "utf8");
    expect(logo).toContain("fill=\"#f9be00\"");
    expect(logo).not.toContain("class=\"cls-");
  });
});

describe("isCompletedTaskOnTime（已完成任务按期判定）", () => {
  it("按实际 / 计划完成日比较；缺日期时只接受显式 on_time=true", () => {
    expect(
      isCompletedTaskOnTime({ status: "done", plannedEnd: "2026-10-19", actualEnd: "2026-10-19", onTime: null }),
    ).toBe(true);
    expect(
      isCompletedTaskOnTime({ status: "done", plannedEnd: "2026-10-19", actualEnd: "2026-10-20", onTime: null }),
    ).toBe(false);
    expect(
      isCompletedTaskOnTime({ status: "done", plannedEnd: null, actualEnd: null, onTime: true }),
    ).toBe(true);
    expect(
      isCompletedTaskOnTime({ status: "active", plannedEnd: null, actualEnd: null, onTime: true }),
    ).toBe(false);
  });
});

describe("renderR06Poster（动态海报 PNG）", () => {
  it("输出 900x1350 PNG，签名与尺寸正确", async () => {
    const buffer = await renderR06Poster(VIEW);
    expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(buffer.readUInt32BE(16)).toBe(900);
    expect(buffer.readUInt32BE(20)).toBe(1350);
    expect(buffer.length).toBeGreaterThan(50_000);
  }, 20_000);

  it("全部任务按时交付时输出黄黑品牌版 900x1350 PNG", async () => {
    const buffer = await renderR06Poster({ ...VIEW, status: "done", taskDone: 44, onTimeDone: 44 });
    expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(buffer.readUInt32BE(16)).toBe(900);
    expect(buffer.readUInt32BE(20)).toBe(1350);
    expect(buffer.length).toBeGreaterThan(100_000);
  }, 20_000);
});
