#!/usr/bin/env node
// 服务边界规则检查（g4）：跨模块深引 / 平台反依赖业务 / 基础设施反依赖业务 / 循环依赖。
// 规则来源：技术设计v0.2-架构与数据模型.md §1.2「依赖规则」。
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcRoot = join(root, "src");

const tsmod = await import("typescript");
const ts = tsmod.default ?? tsmod;

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
  console.error("check:boundaries: 未找到 tsconfig.json");
  process.exit(1);
}
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error("check:boundaries: tsconfig.json 解析失败");
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
const options = parsed.options;

const DOMAIN_MODULES = ["identity", "project", "project-export", "blueprint", "node", "task", "report-issue", "stakeholder", "workspace", "view", "follow"];
const PLATFORM_MODULES = ["file", "notify", "search", "dashboard", "automation", "admin", "audit"];
// 横切模块：领域与平台都可依赖，不参与「平台不得反依赖领域」判定（都不在两个列表里即豁免）。
//   permission —— 权限策略层（h6）；calendar —— 工作日历（h8：平台侧 i8 规则引擎与领域侧任务提醒共用同一出口）。
const CROSSCUT_MODULES = ["permission", "calendar", "translate"];

const files = ts.sys
  .readDirectory(srcRoot, [".ts"], undefined, undefined)
  .filter((file) => !file.endsWith(".d.ts"));

const relOf = (abs) => relative(srcRoot, abs).split(sep).join("/");
const moduleOf = (rel) => {
  const match = /^modules\/([^/]+)\//.exec(rel);
  return match ? match[1] : null;
};

const violations = [];
const edges = new Map();

const record = (fromRel, toRel) => {
  const set = edges.get(fromRel) ?? new Set();
  set.add(toRel);
  edges.set(fromRel, set);
};

const checkRules = (fromRel, toRel, spec) => {
  const fromModule = moduleOf(fromRel);
  const toModule = moduleOf(toRel);

  if (fromModule && toModule && fromModule !== toModule && toRel !== "modules/" + toModule + "/index.ts") {
    violations.push({ rule: "跨模块只允许 import 目标模块 index.ts", fromRel, toRel, spec });
    return;
  }
  if (
    fromModule &&
    toModule &&
    fromModule !== toModule &&
    PLATFORM_MODULES.includes(fromModule) &&
    DOMAIN_MODULES.includes(toModule)
  ) {
    // 豁免 1：file → project 仅限项目快照出口（v0.2 §1.2）。
    // 豁免 2：平台模块 → identity 仅限 index.ts —— 会话 / 鉴权是横切基础设施，平台模块的 HTTP 入口同样要挂
    //         SessionGuard / CsrfGuard（h7 admin 起）；平台模块仍不得 import 其它业务模块。
    const allowed =
      (fromModule === "file" && toModule === "project" && toRel === "modules/project/index.ts") ||
      (toModule === "identity" && toRel === "modules/identity/index.ts");
    if (!allowed) {
      violations.push({
        rule: "平台模块不得反依赖业务模块（file → project 仅限项目快照出口；platform → identity 仅限会话 / 鉴权出口）",
        fromRel,
        toRel,
        spec,
      });
    }
  }
  if (/^(common|db|config|storage)\//.test(fromRel) && /^modules\//.test(toRel)) {
    violations.push({ rule: "common / db / config / storage 不得依赖业务模块", fromRel, toRel, spec });
  }
};

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const specs = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const fromRel = relOf(file);
  for (const spec of specs) {
    const resolved = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule;
    if (!resolved) continue;
    const targetAbs = resolve(resolved.resolvedFileName);
    if (!targetAbs.startsWith(srcRoot + sep)) continue;
    const toRel = relOf(targetAbs);
    record(fromRel, toRel);
    checkRules(fromRel, toRel, spec);
  }
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map();
const stack = [];
const cycles = [];
const dfs = (node) => {
  color.set(node, GRAY);
  stack.push(node);
  for (const next of edges.get(node) ?? []) {
    const state = color.get(next) ?? WHITE;
    if (state === GRAY) {
      cycles.push([...stack.slice(stack.indexOf(next)), next]);
    } else if (state === WHITE) {
      dfs(next);
    }
  }
  stack.pop();
  color.set(node, BLACK);
};
for (const start of edges.keys()) {
  if ((color.get(start) ?? WHITE) === WHITE) dfs(start);
}

const seen = new Set();
const uniqueCycles = cycles.filter((cycle) => {
  const key = [...cycle].sort().join(" | ");
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const crosscut = CROSSCUT_MODULES.filter((name) => DOMAIN_MODULES.includes(name) || PLATFORM_MODULES.includes(name));
if (crosscut.length > 0) {
  console.error("check:boundaries: 横切模块不得同时登记为领域 / 平台模块：" + crosscut.join(", "));
  process.exit(1);
}

const depCount = [...edges.values()].reduce((total, set) => total + set.size, 0);

if (violations.length === 0 && uniqueCycles.length === 0) {
  console.log("check:boundaries: 通过（" + files.length + " 个文件 / " + depCount + " 条内部依赖，0 违规）");
  process.exit(0);
}

console.error("check:boundaries: 发现 " + violations.length + " 处违规依赖、" + uniqueCycles.length + " 个循环：");
for (const item of violations) {
  console.error("  [x] " + item.rule + "：" + item.fromRel + " -> " + item.toRel + "（" + item.spec + "）");
}
for (const cycle of uniqueCycles.slice(0, 5)) {
  console.error("  [x] 循环依赖：" + cycle.join(" -> "));
}
process.exit(1);
