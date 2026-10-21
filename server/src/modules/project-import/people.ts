/**
 * 人员注册表（导入表导入）：姓名 → 登录名 / 显示名（口径 = 转换器 people-registry.json；
 * username = 拼音全拼无后缀；displayName = 中文名 + -test，既有账号保持原名）。
 * 新人员请在 PEOPLE_REGISTRY 补一行（服务端唯一来源；表里出现未收录姓名时预览会给出提醒）。
 */

export interface PeopleRegistryEntry {
  username: string;
  displayName: string;
  note: string;
}

export const PEOPLE_REGISTRY: Record<string, PeopleRegistryEntry> = {
  "贾海洋": { username: "jiahaiyang", displayName: "贾海洋", note: "既有账号（测试站已登录过）" },
  "朱成荣": { username: "zhuchengrong", displayName: "朱成荣-test", note: "" },
  "何玉斓": { username: "heyulan", displayName: "何玉斓-test", note: "" },
  "高云": { username: "gaoyun", displayName: "高云-test", note: "" },
  "史建明": { username: "shijianming", displayName: "史建明-test", note: "既有账号（UK 轮已建）" },
  "余仕铭": { username: "yushiming", displayName: "余仕铭-test", note: "既有账号（UK 轮已建）" },
  "赵纯德": { username: "zhaochunde", displayName: "赵纯德-test", note: "" },
  "张亚庆": { username: "zhangyaqing", displayName: "张亚庆-test", note: "" },
  "王瑞宸": { username: "wangruichen", displayName: "王瑞宸-test", note: "" },
  "董伊涛": { username: "dongyitao", displayName: "董伊涛-test", note: "" },
  "陈建波": { username: "chenjianbo", displayName: "陈建波-test", note: "既有账号（UK 轮已建）" },
  "张栩滔": { username: "zhangxutao", displayName: "张栩滔-test", note: "" },
  "王素芳": { username: "wangsufang", displayName: "王素芳-test", note: "" },
  "Janos Kazi": { username: "janoskazi", displayName: "雅努斯-test", note: "外籍同事（username / 显示名待业务确认）" },
  "张玉龙": { username: "zhangyulong", displayName: "张玉龙-test", note: "" },
  "李旭": { username: "lixu", displayName: "李旭-test", note: "" },
  "黄亮": { username: "huangliang", displayName: "黄亮-test", note: "" },
};

/** 去括注（如「贾海洋（项目经理）」→「贾海洋」）。 */
export function stripParen(name: string): string {
  const index = name.indexOf("(");
  return (index >= 0 ? name.slice(0, index) : name).trim();
}

/** 按姓名取账号建议；未收录 = null（预览给出「人员未收录」提醒）。 */
export function proposeAccount(rawName: string): PeopleRegistryEntry | null {
  const base = stripParen(rawName).split(" ").join(" ").trim();
  if (base === "") return null;
  const entry = PEOPLE_REGISTRY[base];
  return entry === undefined ? null : entry;
}
