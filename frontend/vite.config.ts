import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 本地联调（k6）：前端固定在 3000；会话（/auth/*）与业务接口（/api/v1）都由 Vite 代理到后端 api。
 * 后端默认 PORT=3000 与前端冲突，本地把 server/.env 的 PORT 设为 3001（见 frontend/.env.example）。
 * 生产环境没有 Vite：站点域名直接指向后端（Nginx 反代），Casdoor Redirect URL 登记站点域名。
 *
 * 2026-10-13 追订（Push 301 · §6.16 ㉕）：/api/v1/translate 特例代理**已删除** —— 翻译通道改由后端 server/
 * 实现（译文库优先 + HY-MT1.5-1.8B 引擎兜底 + 保存链路后台预热落库，见 server/src/modules/translate/），
 * 前端只与 POST /api/v1/translate 与 /api/v1/translate/batch 对话，开发环境同样经 /api/v1 通用代理到后端。
 * （旧口径：Vite 把 /api/v1/translate rewrite 到 127.0.0.1:5008 翻译引擎 —— 已随本刀移除。）
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendOrigin = env.BACKEND_ORIGIN === undefined || env.BACKEND_ORIGIN === "" ? "http://127.0.0.1:3001" : env.BACKEND_ORIGIN;
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 3000,
      strictPort: true,
      proxy: {
        "/api/v1": { target: backendOrigin, changeOrigin: true },
        "/auth": { target: backendOrigin, changeOrigin: true },
        "/healthz": { target: backendOrigin, changeOrigin: true },
        "/readyz": { target: backendOrigin, changeOrigin: true },
      },
    },
  };
});
