#!/usr/bin/env node
/**
 * H1 S6 浏览器回归专用 ONLYOFFICE api.js 桩。
 *
 * 目的：让前端真实的 OnlyOfficeViewer 生命周期（加载 api.js → new DocEditor →
 * onDocumentReady → data-oo-status=ready）在 CI 可达，同时不把 DocServer 镜像、
 * 编辑会话与许可证带进确定性浏览器作业。
 *
 * 边界：本桩不模拟文档渲染，不接收 Cookie / 会话令牌，也不读取宿主页面数据；
 * 真实 ONLYOFFICE 文档渲染仍必须在发布窗口用真实 DocServer 人工验收。
 */
import { createServer } from "node:http";
import process from "node:process";

const HOST = process.env.H1_OO_STUB_HOST ?? "127.0.0.1";
const PORT = Number(process.env.H1_OO_STUB_PORT ?? "8001");

const API_JS = String.raw`(() => {
  const instances = new Map();
  class DocEditor {
    constructor(placeholderId, config) {
      this.placeholderId = placeholderId;
      this.config = config;
      this.destroyed = false;
      const host = document.getElementById(placeholderId);
      if (host !== null) {
        host.setAttribute("data-h1-oo-stub", "mounted");
      }
      instances.set(placeholderId, this);
      window.setTimeout(() => {
        if (this.destroyed) return;
        const event = this.config && this.config.events;
        if (event && typeof event.onDocumentReady === "function") {
          event.onDocumentReady({ data: { type: "documentReady", status: "ready" } });
        }
      }, 25);
    }
    destroyEditor() {
      this.destroyed = true;
      instances.delete(this.placeholderId);
    }
  }
  window.DocsAPI = { DocEditor };
})();`;

function send(response, status, headers, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://stub.invalid").pathname;
  if (request.method === "GET" && pathname === "/healthz") {
    send(response, 200, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ ok: true, mode: "h1-e2e-stub" }));
    return;
  }
  if (request.method === "GET" && pathname === "/web-apps/apps/api/documents/api.js") {
    send(response, 200, { "content-type": "application/javascript; charset=utf-8" }, API_JS);
    return;
  }
  send(response, 404, { "content-type": "text/plain; charset=utf-8" }, "not found\n");
});

server.listen(PORT, HOST, () => {
  process.stdout.write("h1-onlyoffice-stub listening on " + HOST + ":" + String(PORT) + "\n");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
