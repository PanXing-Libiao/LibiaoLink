import { z } from "../zod.ts";

/**
 * 统一错误码（唯一来源）。
 * 与 技术设计v0.2-架构与数据模型.md §7.2 错误模型表逐条对应（增补清单见 技术设计v0.3 §4.8）；
 * 新增 / 更名错误码必须同步回写该表并重新生成 OpenAPI。
 */
export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "AUTH_REQUIRED",
  "AUTH_CALLBACK_FAILED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "PROJECT_CODE_EXISTS",
  "PROJECT_ARCHIVED",
  "DICT_ITEM_EXISTS",
  "DICT_ITEM_IN_USE",
  "STAGE_GATE_NOT_PASSED",
  "ARCHIVE_NOT_READY",
  "ARCHIVE_GATE_NOT_PASSED",
  "BLUEPRINT_NOT_PUBLISHED",
  "NODE_REQUIRED_DOC_MISSING",
  "TASK_REQUIRED_DOC_MISSING",
  "NODE_HAS_FILES",
  "STAGE_STATE_INVALID",
  "NODE_ALREADY_DONE",
  "NODE_ALREADY_EXISTS",
  "NODE_DELETED",
  "TASK_ALREADY_EXISTS",
  "TASK_ALREADY_DONE",
  "TASK_HAS_REFERENCES",
  "TASK_FINALIZED",
  "REPORT_ALREADY_EXISTS",
  "BLUEPRINT_SCHEMA_INVALID",
  "BLUEPRINT_REF_UNKNOWN",
  "FILE_STATE_INVALID",
  "UPLOAD_INCOMPLETE",
  "UPLOAD_SESSION_EXPIRED",
  "FILE_HASH_MISMATCH",
  "IDEMPOTENT_REPLAY",
  "PREVIEW_NOT_READY",
  "PREVIEW_FAILED",
  "IMPORT_FILE_INVALID",
  "IMPORT_PARSE_FAILED",
  "IMPORT_PREVIEW_EXPIRED",
  "IMPORT_CANCELLED",
  "RATE_LIMITED",
  "INTERNAL",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES).openapi("ErrorCode", {
  description: "统一错误码（技术设计v0.2 §7.2）",
});

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** 错误码到 HTTP 状态的映射；IDEMPOTENT_REPLAY 与 PREVIEW_* 是 200 语义（不是失败响应）。 */
export const HTTP_STATUS_BY_ERROR_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  AUTH_REQUIRED: 401,
  AUTH_CALLBACK_FAILED: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  PROJECT_CODE_EXISTS: 409,
  PROJECT_ARCHIVED: 409,
  DICT_ITEM_EXISTS: 409,
  DICT_ITEM_IN_USE: 409,
  STAGE_GATE_NOT_PASSED: 422,
  ARCHIVE_NOT_READY: 409,
  ARCHIVE_GATE_NOT_PASSED: 422,
  BLUEPRINT_NOT_PUBLISHED: 422,
  NODE_REQUIRED_DOC_MISSING: 422,
  TASK_REQUIRED_DOC_MISSING: 422,
  NODE_HAS_FILES: 409,
  STAGE_STATE_INVALID: 409,
  NODE_ALREADY_DONE: 409,
  NODE_ALREADY_EXISTS: 409,
  NODE_DELETED: 409,
  TASK_ALREADY_EXISTS: 409,
  TASK_ALREADY_DONE: 409,
  TASK_HAS_REFERENCES: 409,
  TASK_FINALIZED: 409,
  REPORT_ALREADY_EXISTS: 409,
  BLUEPRINT_SCHEMA_INVALID: 422,
  BLUEPRINT_REF_UNKNOWN: 422,
  FILE_STATE_INVALID: 409,
  UPLOAD_INCOMPLETE: 409,
  UPLOAD_SESSION_EXPIRED: 410,
  FILE_HASH_MISMATCH: 422,
  IDEMPOTENT_REPLAY: 200,
  PREVIEW_NOT_READY: 200,
  PREVIEW_FAILED: 200,
  IMPORT_FILE_INVALID: 400,
  IMPORT_PARSE_FAILED: 422,
  IMPORT_PREVIEW_EXPIRED: 410,
  IMPORT_CANCELLED: 400,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export const ErrorDetailSchema = z
  .object({
    code: z.string().openapi({ example: "too_small" }),
    message: z.string().openapi({ example: "limit 必须是 1~200 的整数" }),
    path: z.string().optional().openapi({ example: "query.limit" }),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ErrorDetail", { description: "字段级错误明细（校验失败、门禁缺件等）" });

/** 统一错误信封：所有非 2xx 响应体的唯一结构。 */
export const ApiErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().openapi({ example: "参数校验失败" }),
    details: z.array(ErrorDetailSchema).default([]),
    traceId: z.string().openapi({ example: "4f1c2f2e-6f8a-4b1e-9a1f-2f6d6f2c9d10" }),
  })
  .openapi("ApiError", { description: "统一错误信封（技术设计v0.2 §7.2）" });

export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
