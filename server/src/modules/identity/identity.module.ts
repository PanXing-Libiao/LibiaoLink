import { Module } from "@nestjs/common";
import { AppConfig } from "../../config/config.module.js";
import { AuditModule } from "../audit/index.js";
import { AuthController } from "./auth.controller.js";
import { CasdoorDirectorySource } from "./casdoor-directory.source.js";
import { CsrfGuard } from "./csrf.guard.js";
import { DepartmentRepository } from "./department.repository.js";
import { DepartmentService } from "./department.service.js";
import { OidcService } from "./oidc.service.js";
import { InternalOrgSyncController, InternalUsersController } from "./internal.controller.js";
import { InternalTokenGuard } from "./internal-token.guard.js";
import { InternalUserService } from "./internal-user.service.js";
import { OrgSyncService } from "./org-sync.service.js";
import { RoleRepository } from "./role.repository.js";
import { RoleService } from "./role.service.js";
import { SessionGuard } from "./auth.guard.js";
import { SessionRepository } from "./session.repository.js";
import { SessionService } from "./session.service.js";
import { UserPreferenceRepository } from "./user-preference.repository.js";
import { UserPreferenceService } from "./user-preference.service.js";
import { UserGroupRepository } from "./user-group.repository.js";
import { UserRepository } from "./user.repository.js";
import { UserService } from "./user.service.js";
import { UsersController } from "./users.controller.js";

/** identity 模块（领域）：SSO 接入、会话、用户、组织同步与角色（h1）。
 * 依赖：audit（Push 173：离职回收 / 组织同步写审计 —— 独立模块，避免 admin ↔ identity 循环）。
 */
@Module({
  imports: [AuditModule],
  controllers: [AuthController, UsersController, InternalUsersController, InternalOrgSyncController],
  providers: [
    OidcService,
    SessionService,
    UserService,
    UserPreferenceService,
    UserPreferenceRepository,
    SessionRepository,
    UserRepository,
    UserGroupRepository,
    SessionGuard,
    CsrfGuard,
    DepartmentRepository,
    DepartmentService,
    RoleRepository,
    RoleService,
    OrgSyncService,
    InternalTokenGuard,
    InternalUserService,
    {
      provide: CasdoorDirectorySource,
      useFactory: (config: AppConfig) =>
        new CasdoorDirectorySource({
          issuer: config.env.CASDOOR_ISSUER,
          owner: config.env.CASDOOR_ORG_NAME,
          clientId: config.env.CASDOOR_CLIENT_ID,
          clientSecret: config.env.CASDOOR_CLIENT_SECRET,
        }),
      inject: [AppConfig],
    },
  ],
  exports: [
    SessionService,
    UserService,
    UserGroupRepository,
    SessionGuard,
    CsrfGuard,
    DepartmentService,
    RoleService,
    OrgSyncService,
    InternalUserService,
    CasdoorDirectorySource,
  ],
})
export class IdentityModule {}
