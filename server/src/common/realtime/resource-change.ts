import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { tap } from "rxjs";

export const RESOURCE_CHANGE_SINK = "libiaolink:resource-change-sink";
export const LIVE_RESOURCES = ["projects", "tasks", "reports", "issues", "files", "stakeholders", "templates", "dicts", "users", "audit", "permissions", "preferences"] as const;
export type LiveResource = (typeof LIVE_RESOURCES)[number];
export interface ResourceChangeSink { changed(resources: readonly LiveResource[]): void }

/** Invalidation hints contain no record ids or business data; reads still enforce their original permissions. */
export function changedResources(method: string, url: string): LiveResource[] {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) return [];
  const path = url.split("?")[0] ?? "";
  if (/^\/api\/v1\/projects(?:\/|$)/.test(path)) {
    if (/\/(?:exports|can-complete|can-advance)(?:\/|$)/.test(path)) return [];
    if (/\/reports(?:\/|$)/.test(path)) return ["reports", "issues", "tasks", "projects"];
    if (/\/issues(?:\/|$)/.test(path)) return ["issues", "reports"];
    return ["projects", "tasks"];
  }
  if (/^\/api\/v1\/(?:nodes|blueprint|blueprints)(?:\/|$)/.test(path)) return ["projects", "tasks"];
  // 导入表导入（Push 316 服务端落地）：只有 commit 写业务数据（preview 只落票据）；一次写入横跨项目 / 任务 / 日报 / 问题 / 文件，节点补库还动 templates。
  if (/^\/api\/v1\/project-imports(?:\/|$)/.test(path)) {
    return /\/commit(?:\/|$)/.test(path) ? ["projects", "tasks", "reports", "issues", "files", "templates"] : [];
  }
  if (/^\/api\/v1\/files(?:\/|$)/.test(path)) {
    if (/\/(?:parts|abort|uploads)$/.test(path)) return [];
    return ["files", "tasks", "reports", "issues"];
  }
  if (/^\/api\/v1\/stakeholders(?:\/|$)/.test(path)) return ["stakeholders"];
  if (/^\/api\/v1\/(?:task-nodes|task-templates)(?:\/|$)/.test(path)) return ["templates", "tasks"];
  if (/^\/api\/v1\/dicts(?:\/|$)/.test(path)) return ["dicts", "projects"];
  if (/^\/api\/v1\/users(?:\/|$)/.test(path) && !path.endsWith("/preferences")) return ["users"];
  if (/^\/internal\/(?:users|org-sync)(?:\/|$)/.test(path)) return ["users", "permissions", "projects", "tasks", "files", "stakeholders"];
  if (/^\/api\/v1\/(?:roles|admin)(?:\/|$)/.test(path)) return ["permissions", "users", "projects", "stakeholders"];
  return [];
}

@Injectable()
export class ResourceChangeInterceptor implements NestInterceptor {
  constructor(@Inject(RESOURCE_CHANGE_SINK) private readonly sink: ResourceChangeSink) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{ method: string; originalUrl?: string; url: string }>();
    const resources = changedResources(request.method, request.originalUrl ?? request.url);
    // Controller promises resolve after the business transaction commits. Rejected writes never emit.
    return next.handle().pipe(tap(() => {
      if (resources.length > 0) this.sink.changed(resources);
    }));
  }
}
