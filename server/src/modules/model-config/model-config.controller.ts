import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { AiModelActivateSchema, AiModelProviderCreateSchema, AiModelProviderUpdateSchema, UuidSchema } from "@libiaolink/contracts";
import type { AiModelActivate, AiModelList, AiModelProvider, AiModelProviderCreate, AiModelProviderUpdate, AiModelSettings } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { GroupAccessAdminGuard } from "../permission/index.js";
import { ModelConfigService } from "./model-config.service.js";

@Controller("api/v1/model-settings")
@UseGuards(SessionGuard, CsrfGuard, GroupAccessAdminGuard)
export class ModelConfigController {
  constructor(private readonly models: ModelConfigService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  list(): Promise<AiModelSettings> { return this.models.list(); }

  @Post("providers")
  create(@Body(new ZodValidationPipe(AiModelProviderCreateSchema)) body: AiModelProviderCreate, @CurrentActorId() actor: string): Promise<AiModelProvider> {
    return this.models.create(body, actor);
  }

  @Put("providers/:id")
  update(@Param("id", new ZodValidationPipe(UuidSchema)) id: string, @Body(new ZodValidationPipe(AiModelProviderUpdateSchema)) body: AiModelProviderUpdate, @CurrentActorId() actor: string): Promise<AiModelProvider> {
    return this.models.update(id, body, actor);
  }

  @Delete("providers/:id")
  @HttpCode(204)
  remove(@Param("id", new ZodValidationPipe(UuidSchema)) id: string, @CurrentActorId() actor: string): Promise<void> {
    return this.models.remove(id, actor);
  }

  @Get("providers/:id/models")
  @Header("Cache-Control", "no-store")
  listModels(@Param("id", new ZodValidationPipe(UuidSchema)) id: string): Promise<AiModelList> {
    return this.models.models(id);
  }

  @Put("active")
  @HttpCode(204)
  activate(@Body(new ZodValidationPipe(AiModelActivateSchema)) body: AiModelActivate, @CurrentActorId() actor: string): Promise<void> {
    return this.models.activate(body, actor);
  }
}
