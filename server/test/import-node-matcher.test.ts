import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/config.module.js";
import { ImportNodeMatcher } from "../src/modules/project-import/import-node-matcher.js";

const library = [
  { id: "node-1", stageKey: "install", title: "设备通电测试", titleEn: "Power test", version: 1 },
  { id: "node-2", stageKey: "design", title: "设备设计", titleEn: null, version: 1 },
];
const inputs = [
  { index: 0, stageKey: "install", title: "设备上电检查", titleEn: null },
  { index: 1, stageKey: "install", title: "现场网络部署", titleEn: null },
  { index: 2, stageKey: "install", title: "设备验收", titleEn: null },
];

function matcher(baseUrl = "https://model.example/v1"): ImportNodeMatcher {
  return new ImportNodeMatcher({
    env: {
      TRANSLATE_API_BASE_URL: baseUrl,
      TRANSLATE_API_MODEL: "test-model",
      TRANSLATE_API_KEY: "",
      TRANSLATE_TIMEOUT_MS: 1000,
    },
  } as AppConfig, { active: async () => null } as never);
}

afterEach(() => vi.unstubAllGlobals());

describe("导入节点语义匹配", () => {
  it("只提供同阶段节点，复用有效匹配并保留新节点与不确定状态", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ matches: [
        { index: 0, decision: "match", nodeId: "node-1" },
        { index: 1, decision: "new", nodeId: null },
        { index: 2, decision: "uncertain", nodeId: null },
      ] }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await matcher().match(inputs, library);
    expect(result.get(0)).toEqual({ kind: "semantic", nodeId: "node-1" });
    expect(result.get(1)).toEqual({ kind: "new", nodeId: null });
    expect(result.get(2)).toEqual({ kind: "uncertain", nodeId: null });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const prompt = JSON.parse(body.messages[1].content);
    expect(prompt.existing.map((node: { id: string }) => node.id)).toEqual(["node-1"]);
    expect(prompt.imported).toHaveLength(3);
  });

  it("模型给出无效节点、重复条目或不可解析回复时进入人工确认", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ matches: [
        { index: 0, decision: "match", nodeId: "node-2" },
        { index: 1, decision: "new", nodeId: null },
        { index: 1, decision: "match", nodeId: "node-1" },
      ] }) } }],
    }))));
    const result = await matcher().match(inputs, library);
    expect([...result.values()]).toEqual([
      { kind: "uncertain", nodeId: null },
      { kind: "uncertain", nodeId: null },
      { kind: "uncertain", nodeId: null },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json")));
    expect((await matcher().match(inputs, library)).get(0)?.kind).toBe("uncertain");
  });

  it("网关未配置或请求失败时不把未知节点当作新节点", async () => {
    expect((await matcher("").match(inputs, library)).get(0)?.kind).toBe("uncertain");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect((await matcher().match(inputs, library)).get(0)?.kind).toBe("uncertain");
    expect((await matcher("").match(inputs, [])).get(0)?.kind).toBe("new");
  });
});

describe("导入节点英文补全", () => {
  it("批量翻译缺失英文并按原索引返回", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const payload = JSON.parse(body.messages[1].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        translations: payload.tasks.map((task: { index: number }) => ({ index: task.index, english: "Task " + task.index })),
      }) } }] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const inputs = Array.from({ length: 26 }, (_, index) => ({ index, title: "测试任务" + index }));
    const result = await matcher().translateNames(inputs);
    expect(result.size).toBe(26);
    expect(result.get(25)).toBe("Task 25");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });


  it("沿用现有术语表，并拒绝丢失受保护术语的译文", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const tasks = JSON.parse(body.messages[1].content).tasks as Array<{ index: number; title: string }>;
      const token = tasks[0]!.title.match(/Xq\d+Y/)?.[0];
      expect(token).toBeDefined();
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        translations: [{ index: 0, english: "Equipment " + token }, { index: 1, english: "On-site testing" }],
      }) } }] }));
    }));
    const result = await matcher().translateNames([{ index: 0, title: "设备调试" }, { index: 1, title: "现场联调" }]);
    expect(result.get(0)).toBe("Equipment Commissioning");
    expect(result.has(1)).toBe(false);
  });
  it("拒绝无效或重复译文，服务不可用时保留空值", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ translations: [
        { index: 0, english: "Valid English" },
        { index: 0, english: "Duplicate" },
        { index: 1, english: "依然是中文" },
        { index: 2, english: "설치 test" },
        { index: 99, english: "Unrequested" },
      ] }) } }],
    }))));
    expect((await matcher().translateNames([{ index: 0, title: "测试" }, { index: 1, title: "安装" }, { index: 2, title: "설치" }])).size).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect((await matcher().translateNames([{ index: 0, title: "测试" }])).size).toBe(0);
  });
});
