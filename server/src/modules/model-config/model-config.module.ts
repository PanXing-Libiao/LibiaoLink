import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { ModelConfigController } from "./model-config.controller.js";
import { ModelConfigRepository } from "./model-config.repository.js";
import { ModelConfigService } from "./model-config.service.js";

@Module({
  imports: [IdentityModule, PermissionModule, AuditModule],
  controllers: [ModelConfigController],
  providers: [ModelConfigRepository, ModelConfigService],
  exports: [ModelConfigService],
})
export class ModelConfigModule {}
