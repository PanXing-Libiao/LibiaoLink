import { Controller, Get, UseGuards } from "@nestjs/common";
import type {
  DashboardChangeWordsResponse,
  DashboardIssuesResponse,
  DashboardProgressResponse,
} from "@libiaolink/contracts";
import { CurrentActorId, SessionGuard } from "../identity/index.js";
import { DashboardService } from "./dashboard.service.js";

/**
 * 仪表盘聚合接口（B4 / M7-02 · 平台模块）：
 * 根路径 /api/v1/dashboard；仅会话守卫，不做功能权限位，数据按项目可见性过滤。
 */
@Controller("api/v1/dashboard")
@UseGuards(SessionGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** 首屏任务聚合：项目进度 / 任务状态 / 交付时间。 */
  @Get("progress")
  progress(@CurrentActorId() actorId: string): Promise<DashboardProgressResponse> {
    return this.dashboard.progress(actorId);
  }

  /** 问题分布聚合（按视图懒加载；明细下钻走项目问题接口）。 */
  @Get("issues")
  issues(@CurrentActorId() actorId: string): Promise<DashboardIssuesResponse> {
    return this.dashboard.issues(actorId);
  }

  /** 变更原因核心词频聚合（按视图懒加载；明细下钻走项目变更接口）。 */
  @Get("change-words")
  changeWords(@CurrentActorId() actorId: string): Promise<DashboardChangeWordsResponse> {
    return this.dashboard.changeWords(actorId);
  }
}
