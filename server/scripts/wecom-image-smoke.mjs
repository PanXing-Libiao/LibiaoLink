#!/usr/bin/env node
/**
 * 本地企微智能机器人图片冒烟：读取 server/.env 的 WECOM_BOT_*，向指定群发送一张本地图片。
 * 用法：npm run wecom:image:smoke -- --chatid <群 chatid> --file <图片路径>
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadEnv } from "../dist/config/env.js";
import {
  aibotImageMimeFromFileName,
  createWecomAibotClientFromEnv,
} from "../dist/modules/notify/wecom.aibot.js";

function loadDotEnv() {
  try {
    process.loadEnvFile(resolve(process.cwd(), ".env"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function maskChatid(chatid) {
  return "****" + chatid.slice(-4);
}

loadDotEnv();
const chatid = argValue("--chatid") ?? process.env.WECOM_TEST_CHATID ?? "";
const file = argValue("--file") ?? "";
const mime = argValue("--mime") ?? null;

if (chatid === "" || file === "") {
  console.error("用法：npm run wecom:image:smoke -- --chatid <群 chatid> --file <图片路径> [--mime image/png]");
  process.exit(2);
}

const env = loadEnv(process.env);
if (env.WECOM_BOT_ID === "" || env.WECOM_BOT_SECRET === "") {
  console.error("WECOM_BOT_ID / WECOM_BOT_SECRET 未配置");
  process.exit(2);
}

const content = readFileSync(resolve(process.cwd(), file));
const fileName = basename(file);
const inferredMime = mime ?? aibotImageMimeFromFileName(fileName);
if (inferredMime === null) {
  console.error("仅支持 PNG / JPG / GIF 图片");
  process.exit(2);
}

const { aibot } = createWecomAibotClientFromEnv(env);
aibot.start();
const ready = await aibot.waitForSubscribed(15_000);
if (!ready) {
  console.error("长连接 15 秒内未订阅成功：state=" + aibot.getStats().state);
  await aibot.stop();
  process.exit(1);
}

console.log("长连接已订阅，开始发送：" + fileName + " · " + String(content.length) + " B · chatid " + maskChatid(chatid));
const result = await aibot.sendGroupImage({
  chatid,
  content,
  fileName,
  mime: inferredMime,
  groupActivated: true,
});
console.log(JSON.stringify(result, null, 2));
await aibot.stop();
if (!result.ok) {
  process.exitCode = 1;
}
