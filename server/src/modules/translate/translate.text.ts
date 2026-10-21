/**
 * 翻译文本加工（服务端 · Push 301 · §6.16 ㉕）：术语保护 / 回换 + 译文规整（Push 311 补「句首大写」）—— 原 frontend/src/translateApi.ts 同款逻辑搬移内聚；规整口径见 §6.16 ㉘。
 *
 * 为什么挪到服务端（2026-10-13 业务口径「当用户写项目进展描述时直接后台翻译 并且写入数据库」）：
 *  - 译文库键 = sha256(原文)：前端读路径（批量查库 / 单条）与保存链路预热（task / project 控制器挂点）必须同键。
 *    术语保护若留在前端，前端 q = 含占位符文本 → 同一原文两种键互相命中不了；且预热路径（服务端）不经过前端、
 *    会漏保护（基督城 → Christtown、仓配 → Hammy 之类实测坏译，见 Push 297 / §6.16 ⑮）。
 *  - 因此所有通路 q 一律**原文**；保护 / 回换 / 规整只在服务端做一次，落库即最终英文（前端只做展示与缓存）。
 *
 * 术语表（Push 297 定稿 11 条）命中即换「Xq + 无连零数字 + Y」占位符 —— 纯字母 / 全大写 / 含 00 的数字 /
 * 相邻无分隔的占位符会被引擎吞或改写，唯此形态实测原样透传（Argos 与 HY-MT1.5-1.8B 均验证通过）；
 * 匹配 = 长词优先（仓配中心 先于 仓配，避免译成「… Center Center」）；人名 / 品牌 / 产品词定稿英文后加一行即可。
 */

/** 常见缩写词（全大写译文规整时保留原样；小模型偶发整句大写，实测 2026-10-10）。 */
const KEEP_UPPER = new Set([
  "WCS", "AGV", "AMR", "PDF", "API", "URL", "ID", "IT", "OK",
  "QC", "QA", "WMS", "GPS", "AI", "UI", "IP", "PLC", "ERP", "MES", "SKU",
]);

/** 译文规整（Push 301 / 311）：去多余空白；整句全大写（小模型偶发）时转句首大写，保留常见缩写与带数字词元；句首小写字母时首字母大写（品牌词形态不误伤）。 */
export function normalizeEnglish(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const letters = trimmed.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4 || letters !== letters.toUpperCase()) {
    return capitalizeSentenceStart(trimmed);
  }
  let atStart = true;
  const out: string[] = [];
  for (const token of trimmed.split(/(\s+)/)) {
    if (token === "") {
      continue;
    }
    if (/^\s+$/.test(token)) {
      out.push(token);
      continue;
    }
    if (!/[A-Za-z]/.test(token)) {
      out.push(token);
      if (/[.!?]$/.test(token)) {
        atStart = true;
      }
      continue;
    }
    let word: string;
    if (/\d/.test(token) || KEEP_UPPER.has(token.toUpperCase())) {
      word = token.toUpperCase();
    } else {
      word = token.toLowerCase();
      if (atStart) {
        word = word.charAt(0).toUpperCase() + word.slice(1);
      }
    }
    out.push(word);
    atStart = /[.!?]$/.test(word);
  }
  return out.join("");
}

/**
 * 句首大写（Push 311 · §6.16 ㉘）：翻译 API / 小模型偶发小写开头（实测「in dire straits」），
 * 仅当文本以单个小写 ASCII 字母开头、且首个词元不是 iPhone / eBay / pH 类品牌词形态（[a-z]+[A-Z]）时转大写；
 * 占位符（Xq…Y）大写开头不受影响；数字 / 标点开头与已大写开头保持原样（幂等）。
 */
function capitalizeSentenceStart(text: string): string {
  const first = text.charAt(0);
  if (first < "a" || first > "z") {
    return text;
  }
  const firstWord = text.split(" ", 1)[0] ?? "";
  if (/^[a-z]{1,4}[A-Z]/.test(firstWord)) {
    return text;
  }
  return first.toUpperCase() + text.slice(1);
}

/** 领域术语表（原 frontend/src/translateApi.ts 原样搬移；术语不参与机翻、固定译法回换）。 */
const GLOSSARY: ReadonlyArray<{ zh: string; en: string }> = [
  { zh: "基督城", en: "Christchurch" },
  { zh: "立镖", en: "Libiao" },
  { zh: "仓配中心", en: "Warehouse and Distribution Center" },
  { zh: "仓配", en: "Warehouse and Distribution Center" },
  { zh: "分拣中心", en: "Sorting Center" },
  { zh: "分拣线", en: "Sorting Line" },
  { zh: "分拨中心", en: "Distribution Center" },
  { zh: "分拣", en: "Sorting" },
  { zh: "分拨", en: "Distribution" },
  { zh: "联调", en: "Integration Testing" },
  { zh: "调试", en: "Commissioning" },
];

/** 长词优先的匹配序（模块级排一次）。 */
const GLOSSARY_SORTED: ReadonlyArray<{ zh: string; en: string }> = GLOSSARY.slice().sort((a, b) => b.zh.length - a.zh.length);

/** 占位符号码池（六位、无连零，实测原样透传）：一个术语固定取一枚（同文本内不重号；超池追加一位数字）。 */
const TOKEN_NUMBERS: readonly string[] = ["8612345", "8612347", "8612361", "8612371", "8612381", "8612391", "8612412", "8612432", "8612452", "8612462", "8612472", "8612482", "8612492", "8612512", "8612532", "8612542"];

function glossaryToken(index: number): string {
  const base = TOKEN_NUMBERS[index % TOKEN_NUMBERS.length];
  const extra = index < TOKEN_NUMBERS.length ? "" : String(Math.floor(index / TOKEN_NUMBERS.length) + 1);
  return "Xq" + base + extra + "Y";
}

/** 出引擎前：长词优先把命中术语换成占位符（空格包夹，防相邻占位符互相干扰）；返回替换表（无命中 = 空表、原文照发）。 */
export function protectGlossary(text: string): { protectedText: string; tokens: ReadonlyMap<string, string> } {
  let out = text;
  const tokens = new Map<string, string>();
  GLOSSARY_SORTED.forEach((term, index) => {
    if (!out.includes(term.zh)) {
      return;
    }
    const token = glossaryToken(index);
    tokens.set(token, term.en);
    out = out.split(term.zh).join(" " + token + " ");
  });
  if (tokens.size === 0) {
    return { protectedText: text, tokens };
  }
  return { protectedText: out.replace(/\s{2,}/g, " ").trim(), tokens };
}

/** 回包后：占位符换回固定译法（大小写不敏感 + 容忍引擎在字符间塞空格）；随后压掉多余空格与标点前空格。 */
export function restoreGlossary(text: string, tokens: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [token, en] of tokens) {
    const pattern = new RegExp(token.split("").join("\\s*"), "gi");
    out = out.replace(pattern, " " + en + " ");
  }
  return out.replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
}

/** 引擎回包 → 最终英文：先规整（全大写修形），再回换术语占位符（无术语时只规整）。 */
export function finalizeTranslation(text: string, tokens: ReadonlyMap<string, string>): string {
  const normalized = normalizeEnglish(text);
  return tokens.size === 0 ? normalized : restoreGlossary(normalized, tokens);
}
