/**
 * 企微智能机器人图片链路（本地改造 · 2026-10-20）：假 socket 驱动素材 init / chunk / finish 与 image 发送，
 * 不触外网。覆盖分片、media_id 缓存、非法格式与上传回执失败。
 */
import { describe, expect, it } from "vitest";
import {
  WecomAibotClient,
  WECOM_AIBOT_MEDIA_CHUNK_BYTES,
  type AibotSocket,
} from "../src/modules/notify/wecom.aibot.js";
import {
  InMemoryRateWindowStore,
  WecomRateLimiter,
  type WecomRateWindowSpec,
} from "../src/modules/notify/wecom.rate.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSocket implements AibotSocket {
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: ((error: Error) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onclose?.(code ?? 1000, reason ?? "closed by test");
  }

  open(): void {
    this.onopen?.();
  }

  deliver(frame: Record<string, unknown>): void {
    this.onmessage?.(JSON.stringify(frame));
  }

  lastFrame(): Record<string, unknown> {
    const raw = this.sent[this.sent.length - 1];
    if (raw === undefined) {
      throw new Error("无已发送帧");
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }

  ackLast(errcode = 0, errmsg = "ok", body?: Record<string, unknown>): void {
    const headers = this.lastFrame()["headers"] as Record<string, unknown> | undefined;
    const frame: Record<string, unknown> = {
      headers: { req_id: headers?.["req_id"] },
      errcode,
      errmsg,
    };
    if (body !== undefined) {
      frame.body = body;
    }
    this.deliver(frame);
  }
}

function makeClient(windows?: WecomRateWindowSpec[]) {
  const sockets: FakeSocket[] = [];
  const limiter = new WecomRateLimiter({
    store: new InMemoryRateWindowStore(),
    windows:
      windows ??
      [
        { kind: "group", windowMs: 60_000, limit: 100 },
        { kind: "group", windowMs: 3_600_000, limit: 100 },
      ],
  });
  const client = new WecomAibotClient({
    wsUrl: "wss://stub.test/aibot",
    botId: "bot-1",
    secret: "secret-1",
    pingIntervalMs: 1_000_000,
    ackTimeoutMs: 1_000,
    reconnectMinMs: 60_000,
    reconnectMaxMs: 60_000,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    limiter,
  });
  return { client, sockets };
}

async function connect(client: WecomAibotClient, sockets: FakeSocket[]): Promise<FakeSocket> {
  client.start();
  const socket = sockets[sockets.length - 1]!;
  socket.open();
  socket.ackLast(0);
  await sleep(0);
  return socket;
}

async function driveUploadAndSend(socket: FakeSocket, totalChunks: number, mediaId = "media-1"): Promise<void> {
  await sleep(0);
  const init = socket.lastFrame();
  expect(init).toMatchObject({
    cmd: "aibot_upload_media_init",
    body: { type: "image", total_chunks: totalChunks },
  });
  socket.ackLast(0, "ok", { upload_id: "upload-1" });

  for (let index = 0; index < totalChunks; index += 1) {
    await sleep(0);
    const chunk = socket.lastFrame();
    expect(chunk).toMatchObject({
      cmd: "aibot_upload_media_chunk",
      body: { upload_id: "upload-1", chunk_index: String(index) },
    });
    expect(typeof (chunk.body as Record<string, unknown>).base64_data).toBe("string");
    socket.ackLast();
  }

  await sleep(0);
  expect(socket.lastFrame()).toMatchObject({
    cmd: "aibot_upload_media_finish",
    body: { upload_id: "upload-1" },
  });
  socket.ackLast(0, "ok", { type: "image", media_id: mediaId });

  await sleep(0);
  expect(socket.lastFrame()).toMatchObject({
    cmd: "aibot_send_msg",
    body: { chat_type: 2, msgtype: "image", image: { media_id: mediaId } },
  });
  socket.ackLast();
}

describe("企微智能机器人图片链路（本地）", () => {
  it("图片按 512KB 分片上传，finish 后用 media_id 发送 image 消息", async () => {
    const { client, sockets } = makeClient();
    const socket = await connect(client, sockets);
    const content = Buffer.alloc(WECOM_AIBOT_MEDIA_CHUNK_BYTES + 17, 0x41);

    const pending = client.sendGroupImage({
      chatid: "chat-1",
      content,
      fileName: "完工喜报.png",
      groupActivated: true,
    });
    await driveUploadAndSend(socket, 2);
    await expect(pending).resolves.toEqual({ ok: true, attempts: 1 });

    const init = JSON.parse(socket.sent[1]!) as { body: Record<string, unknown> };
    expect(init.body.total_size).toBe(content.length);
    expect(init.body.filename).toBe("完工喜报.png");
    expect(init.body.md5).toMatch(/^[0-9a-f]{32}$/);
    await client.stop();
  });

  it("相同图片内容复用 media_id，第二次只发 image 消息", async () => {
    const { client, sockets } = makeClient();
    const socket = await connect(client, sockets);
    const content = Buffer.from("fake-png-content-for-cache");

    const first = client.sendGroupImage({
      chatid: "chat-1",
      content,
      fileName: "喜报.png",
      groupActivated: true,
    });
    await driveUploadAndSend(socket, 1, "media-cache-1");
    await expect(first).resolves.toEqual({ ok: true, attempts: 1 });

    const framesAfterFirst = socket.sent.length;
    const second = client.sendGroupImage({
      chatid: "chat-1",
      content,
      fileName: "喜报.png",
      groupActivated: true,
    });
    await sleep(0);
    expect(socket.sent.length).toBe(framesAfterFirst + 1);
    expect(socket.lastFrame()).toMatchObject({
      cmd: "aibot_send_msg",
      body: { msgtype: "image", image: { media_id: "media-cache-1" } },
    });
    socket.ackLast();
    await expect(second).resolves.toEqual({ ok: true, attempts: 1 });
    await client.stop();
  });

  it("非法图片格式直接失败，不上传也不发消息", async () => {
    const { client, sockets } = makeClient();
    const socket = await connect(client, sockets);
    const before = socket.sent.length;
    const result = await client.sendGroupImage({
      chatid: "chat-1",
      content: Buffer.from("hello"),
      fileName: "readme.txt",
      groupActivated: true,
    });
    expect(result).toMatchObject({ ok: false, kind: "permanent", attempts: 0 });
    expect(socket.sent.length).toBe(before);
    await client.stop();
  });

  it("素材上传回执失败返回可重试，不发送 image 消息", async () => {
    const { client, sockets } = makeClient();
    const socket = await connect(client, sockets);
    const pending = client.sendGroupImage({
      chatid: "chat-1",
      content: Buffer.from("fake-png-content"),
      fileName: "喜报.png",
      groupActivated: true,
    });
    await sleep(0);
    expect(socket.lastFrame()).toMatchObject({ cmd: "aibot_upload_media_init" });
    socket.ackLast(846609, "not subscribed");
    const result = await pending;
    expect(result).toMatchObject({ ok: false, kind: "retryable", errcode: 846609, attempts: 0 });
    expect(socket.sent.some((raw) => (JSON.parse(raw) as { cmd?: string }).cmd === "aibot_send_msg")).toBe(false);
    await client.stop();
  });
});
