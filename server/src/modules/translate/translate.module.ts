import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/index.js";
import { TranslateController } from "./translate.controller.js";
import { TranslateRepository } from "./translate.repository.js";
import { TranslateService } from "./translate.service.js";

/**
 * translate 模块（横切 · §6.16 ㉕ · Push 301）：内容译文库读写 + 保存链路后台预热。
 * 依赖 identity（会话 / CSRF）；已登记 check-boundaries 的 CROSSCUT_MODULES（领域与平台都可经其 index.ts 复用——
 * 保存链路挂点见 task / project 控制器）。
 */
@Module({
  imports: [IdentityModule],
  controllers: [TranslateController],
  providers: [TranslateRepository, TranslateService],
  exports: [TranslateService],
})
export class TranslateModule {}
