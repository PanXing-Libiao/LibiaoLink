/**
 * 日报群同步双海报回归（2026-10-27 终稿）：1440px 宽动态高度、思源黑体随包渲染，
 * 日报 / 问题专报分离，全部长文本与图片进入版面，缺图坏图只留占位片。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizePosterIssueTitle,
  renderDailyReportIssuePoster,
  renderDailyReportPoster,
  stripPosterListMarkers,
  type DailyReportPosterData,
} from "../src/modules/notify/daily-report.poster.js";

const SAMPLE: DailyReportPosterData = {
  projectId: "11111111-1111-4111-8111-111111111111",
  projectCode: "LBGW-20260331-1459",
  projectName: "UK-VANILLA-AIRROB",
  managers: ["贾海洋", "潘兴"],
  reportId: "22222222-2222-4222-8222-222222222222",
  reportDate: "2026-10-05",
  state: "submitted",
  authorName: "陈工",
  headcount: 2,
  doneWork: [
    "1 上电测试 50% 已完成工作站全部上电",
    "2 配置设备 ip 已完成",
    "3 与客户网络对接并增加网线",
  ].join("\n"),
  plan: [
    "1 飞箱上电",
    "2 RCS 调试",
    "3 地面清洁",
  ].join("\n"),
  stages: ["售前"],
  submittedAt: "2026-10-05T10:42:00.000Z",
  photos: [
    { fileId: "photo-1", name: "现场-1.jpg", objectKey: "onsite/1.jpg", mime: "image/jpeg" },
    { fileId: "photo-2", name: "现场-2.jpg", objectKey: "onsite/2.jpg", mime: "image/jpeg" },
    { fileId: "photo-3", name: "现场-3.jpg", objectKey: "onsite/3.jpg", mime: "image/jpeg" },
    { fileId: "photo-4", name: "现场-4.jpg", objectKey: "onsite/4.jpg", mime: "image/jpeg" },
  ],
  issues: [
    {
      id: "issue-1",
      title: "1 拖 4 KVM 转换器频闪，RCS01 网口无法使用，换 RCS02 网口后仍异常，判断为网口主板问题",
      categories: ["供应商原因"],
      ownerName: "贾海洋",
      state: "in_progress",
      solution: [
        "1 视频线更换为屏蔽线",
        "2 快递网口主板进行更换",
        "3 10-12 已到货，更换后仍会出现频闪现象",
      ].join("\n"),
      photos: [
        { fileId: "issue-photo-1", name: "问题-1.jpg", objectKey: "issue/1.jpg", mime: "image/jpeg" },
        { fileId: "issue-photo-2", name: "问题-2.jpg", objectKey: "issue/2.jpg", mime: "image/jpeg" },
      ],
    },
    {
      id: "issue-2",
      title: "西侧通道临时围挡未闭合，已要求当日整改并回传照片",
      categories: ["安全管理"],
      ownerName: "赵工",
      state: "open",
      solution: "现场已完成临时围挡加高，待安全员复核。",
      photos: [
        { fileId: "issue-photo-3", name: "问题-3.jpg", objectKey: "issue/3.jpg", mime: "image/jpeg" },
      ],
    },
  ],
};

function pngSize(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe("海报编号清洗", () => {
  it("去掉行首重复枚举号，保留业务内容与数量", () => {
    expect(stripPosterListMarkers("1: 1 wms与wes联调")).toBe("wms与wes联调");
    expect(stripPosterListMarkers("2: 2 周转箱上架 2500箱")).toBe("周转箱上架 2500箱");
    expect(stripPosterListMarkers("1 1 工作站组装 25%")).toBe("工作站组装 25%");
    expect(stripPosterListMarkers("（2）复测完成")).toBe("复测完成");
    expect(stripPosterListMarkers("3: 500 箱到货")).toBe("500 箱到货");
    expect(stripPosterListMarkers("3D 分拣异常")).toBe("3D 分拣异常");
    expect(stripPosterListMarkers("10月9日现场检查")).toBe("10月9日现场检查");
    expect(stripPosterListMarkers("24小时连续运行")).toBe("24小时连续运行");
    expect(stripPosterListMarkers("1拖4 kvm转换器")).toBe("1拖4 kvm转换器");
    expect(stripPosterListMarkers("1  1拖4 kvm转换器")).toBe("1拖4 kvm转换器");
    expect(stripPosterListMarkers("1: 1拖4 kvm转换器")).toBe("1拖4 kvm转换器");
  });

  it("问题标题只清首个有效行的外层编号，后续行保留", () => {
    expect(normalizePosterIssueTitle("1: 1 网口异常\n2 更换主板后复查")).toBe("网口异常\n2 更换主板后复查");
    expect(normalizePosterIssueTitle("1  1拖4 kvm转换器 出现频闪 无法使用")).toBe("1拖4 kvm转换器 出现频闪 无法使用");
  });
});

describe("日报群同步双海报", () => {
  it("日报海报固定 1440px 宽，无现场图也完整输出动态高度 PNG", async () => {
    const buffer = await renderDailyReportPoster({
      ...SAMPLE,
      photos: [],
      issues: SAMPLE.issues.map((issue) => ({ ...issue, photos: [] })),
    });
    const size = pngSize(buffer);
    expect(size.width).toBe(1440);
    expect(size.height).toBeGreaterThan(700);
    expect(buffer.length).toBeGreaterThan(50_000);
  }, 20_000);

  it("日报与问题专报分别消费全部图片，坏图只留占位片", async () => {
    const bytes = readFileSync(new URL("../assets/r06-brand-banner.jpg", import.meta.url));
    const images = new Map<string, Buffer>([
      ["photo-1", bytes],
      ["photo-2", bytes],
      ["photo-3", bytes],
      ["photo-4", Buffer.from("not an image")],
      ["issue-photo-1", bytes],
      ["issue-photo-2", bytes],
      ["issue-photo-3", bytes],
    ]);
    const daily = await renderDailyReportPoster(SAMPLE, images);
    const issue = await renderDailyReportIssuePoster(SAMPLE, images);
    const dailySize = pngSize(daily);
    const issueSize = pngSize(issue);
    expect(dailySize.width).toBe(1440);
    expect(issueSize.width).toBe(1440);
    expect(dailySize.height).toBeGreaterThan(1_000);
    expect(issueSize.height).toBeGreaterThan(800);
    expect(daily.length).toBeGreaterThan(100_000);
    expect(issue.length).toBeGreaterThan(100_000);
  }, 30_000);

  it("长项目名、长正文、多项问题与多张图片全部进入版面且不抛错", async () => {
    const bytes = readFileSync(new URL("../assets/r06-brand-banner.jpg", import.meta.url));
    const issues = Array.from({ length: 6 }, (_, index) => ({
      ...SAMPLE.issues[index % SAMPLE.issues.length]!,
      id: "issue-long-" + String(index + 1),
      title:
        "现场问题 " +
        String(index + 1) +
        "：预留孔洞偏差需要土建复核并调整，整改完成后回传复测照片与验收记录。".repeat(4),
      solution:
        "处理记录：" + "已完成现场复核、责任分派、材料更换与复测，排查结果和处理动作全部保留。".repeat(8),
      photos: [
        { fileId: "long-issue-" + String(index) + "-1", name: "问题.jpg", objectKey: "issue/long.jpg", mime: "image/jpeg" },
        { fileId: "long-issue-" + String(index) + "-2", name: "问题.jpg", objectKey: "issue/long.jpg", mime: "image/jpeg" },
      ],
    }));
    const photos = Array.from({ length: 8 }, (_, index) => ({
      fileId: "long-photo-" + String(index + 1),
      name: "现场.jpg",
      objectKey: "onsite/long.jpg",
      mime: "image/jpeg",
    }));
    const images = new Map<string, Buffer>();
    for (const photo of [...photos, ...issues.flatMap((issue) => issue.photos)]) {
      images.set(photo.fileId, bytes);
    }
    const data: DailyReportPosterData = {
      ...SAMPLE,
      projectName: "华东新能源汽车智能总装输送系统升级改造项目现场实施与调试工程".repeat(2),
      doneWork: "1. " + "完成主线体安装与找平、复核安全光栅点位。".repeat(30),
      plan: "1. " + "完成后续工位安装、联动调试与孔洞整改复测。".repeat(30),
      photos,
      issues,
    };
    const daily = await renderDailyReportPoster(data, images);
    const issue = await renderDailyReportIssuePoster(data, images);
    const dailySize = pngSize(daily);
    const issueSize = pngSize(issue);
    expect(dailySize.width).toBe(1440);
    expect(issueSize.width).toBe(1440);
    expect(dailySize.height).toBeGreaterThan(2_500);
    expect(issueSize.height).toBeGreaterThan(2_500);
  }, 30_000);

  it("无问题专报仍可渲染空态，供边界排查使用", async () => {
    const buffer = await renderDailyReportIssuePoster({ ...SAMPLE, issues: [] });
    const size = pngSize(buffer);
    expect(size.width).toBe(1440);
    expect(size.height).toBeGreaterThan(500);
  }, 20_000);
});
