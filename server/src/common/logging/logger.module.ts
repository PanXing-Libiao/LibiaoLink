import type { DynamicModule } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "node:crypto";
import type { Env } from "../../config/env.js";

/** api / worker 共用的结构化日志（Pino JSON）；字段规范见 server/README.md。 */
export function createLoggerModule(env: Env): DynamicModule {
  return LoggerModule.forRoot({
    pinoHttp: {
      level: env.LOG_LEVEL,
      redact: ["req.headers.cookie", "req.headers.authorization", 'req.headers["x-csrf-token"]', 'req.headers["x-internal-token"]', 'res.headers["set-cookie"]'],
      genReqId: (request, response) => {
        const header = request.headers["x-request-id"];
        const candidate = Array.isArray(header) ? header[0] : header;
        const traceId =
          typeof candidate === "string" && candidate.length > 0 ? candidate : randomUUID();
        response.setHeader("X-Request-Id", traceId);
        return traceId;
      },
    },
  });
}
