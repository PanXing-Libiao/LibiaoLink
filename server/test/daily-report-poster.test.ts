/**
 * 日报群同步海报回归（2026-10-27）：1080×1120 PNG、思源黑体随包渲染、现场图 / 问题图 / 长文本 / 缺图坏图容错。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  renderDailyReportPoster,
  type DailyReportPosterData,
} from "../src/modules/notify/daily-report.poster.js";

const SAMPLE: DailyReportPosterData = {
  projectId: "11111111-1111-4111-8111-111111111111",
  projectCode: "LB-2026-018",
  projectName: "新能源汽车总装输送线项目",
  managers: ["王磊"],
  reportId: "22222222-2222-4222-8222-222222222222",
  reportDate: "2026-10-27",
  state: "submitted",
  authorName: "陈工",
  headcount: 28,
  doneWork: [
    "1. 完成主线体 3#—5# 工位输送机定位与找平",
    "2. 完成 2# 驱动单元接线与空载试运行，电流数据正常",
    "3. 配合甲方完成安全光栅点位复核，确认 12 个点位",
    "4. 完成现场成品保护及工器具清点，移交明日班组",
  ].join("\n"),
  plan: [
    "1. 完成 6#—8# 工位机械安装与初调",
    "2. 主线联动调试，验证输送节拍与急停链路",
    "3. 跟进 3# 工位孔洞偏差整改，完成复测",
  ].join("\n"),
  stages: ["机械安装", "电气调试", "现场调试"],
  submittedAt: "2026-10-27T10:42:00.000Z",
  photos: [
    { fileId: "photo-1", name: "现场.jpg", objectKey: "onsite/1.jpg", mime: "image/jpeg" },
    { fileId: "photo-2", name: "现场.jpg", objectKey: "onsite/2.jpg", mime: "image/jpeg" },
    { fileId: "photo-3", name: "现场.jpg", objectKey: "onsite/3.jpg", mime: "image/jpeg" },
  ],
  issues: [
    {
      id: "issue-1",
      title: "3# 工位预留孔洞偏差 15mm，需土建复核并调整",
      categories: ["机械部", "安装"],
      ownerName: "李工",
      state: "open",
      photos: [{ fileId: "issue-photo-1", name: "问题.jpg", objectKey: "issue/1.jpg", mime: "image/jpeg" }],
    },
    {
      id: "issue-2",
      title: "西侧通道临时围挡未闭合，已要求当日整改并回传照片",
      categories: ["现场", "安全"],
      ownerName: "赵工",
      state: "in_progress",
      photos: [{ fileId: "issue-photo-2", name: "问题.jpg", objectKey: "issue/2.jpg", mime: "image/jpeg" }],
    },
  ],
};

function assertPng(buffer: Buffer): void {
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buffer.readUInt32BE(16)).toBe(1080);
  expect(buffer.readUInt32BE(20)).toBe(1120);
}

describe("renderDailyReportPoster（日报项目群海报）", () => {
  it("无现场图也输出 1080×1120 PNG（保留问题文字，不依赖 Noto）", async () => {
    const buffer = await renderDailyReportPoster({ ...SAMPLE, photos: [], issues: SAMPLE.issues.map((issue) => ({ ...issue, photos: [] })) });
    assertPng(buffer);
    expect(buffer.length).toBeGreaterThan(50_000);
  }, 20_000);

  it("现场图 + 问题附图按 fileId 进入版面，坏图只留占位片", async () => {
    const bytes = readFileSync(new URL("../assets/r06-brand-banner.jpg", import.meta.url));
    const images = new Map<string, Buffer>([
      ["photo-1", bytes],
      ["photo-2", bytes],
      ["photo-3", bytes],
      ["issue-photo-1", Buffer.from("not an image")],
      ["issue-photo-2", bytes],
    ]);
    const buffer = await renderDailyReportPoster(SAMPLE, images);
    assertPng(buffer);
    expect(buffer.length).toBeGreaterThan(100_000);
  }, 20_000);

  it("长标题、长正文与多项问题不越界、不抛错", async () => {
    const issues = Array.from({ length: 8 }, (_, index) => ({
      ...SAMPLE.issues[index % SAMPLE.issues.length]!,
      id: "issue-long-" + String(index + 1),
      title: "现场问题 " + String(index + 1) + "：预留孔洞偏差需要土建复核并调整，整改完成后回传复测照片与验收记录。",
      photos: [],
    }));
    const buffer = await renderDailyReportPoster({
      ...SAMPLE,
      projectName: "华东新能源汽车智能总装输送系统升级改造项目",
      doneWork: "1. " + "完成主线体安装与找平、复核安全光栅点位。".repeat(8),
      plan: "1. " + "完成后续工位安装、联动调试与孔洞整改复测。".repeat(8),
      photos: [],
      issues,
    });
    assertPng(buffer);
  }, 20_000);
});
