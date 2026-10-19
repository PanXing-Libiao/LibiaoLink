/**
 * 本文件由 shared/scripts/generate.mjs 生成，禁止手改（CONTRIBUTING 第 14 节）。
 * 源：shared/src 下的 Zod schema → generated/openapi.json → 本文件。
 */
export interface paths {
    "/api/v1/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 项目列表（分页 + 多维筛选 + 排序） */
        get: {
            parameters: {
                query?: {
                    /** @description 地区（多值逗号分隔） */
                    "filter[region]"?: string;
                    /** @description 项目类型（多值逗号分隔） */
                    "filter[projectType]"?: string;
                    /** @description 项目经理（多值逗号分隔，UUID）；命中口径（A22 · Push 136）= 项目挂的任意一位经理命中即命中 */
                    "filter[managerId]"?: string;
                    /** @description 阶段 key（多值逗号分隔） */
                    "filter[stageKey]"?: string;
                    /** @description 项目状态（多值逗号分隔） */
                    "filter[status]"?: string;
                    /** @description 项目**创建时间**下界（YYYY-MM-DD，含当日；按 Asia/Shanghai 取当日 00:00:00+08:00；Push 175 起维度 = projects.created_at） */
                    "filter[timeFrom]"?: components["schemas"]["DateOnly"];
                    /** @description 项目**创建时间**上界（YYYY-MM-DD，含当日；按次日 00:00:00+08:00 不含截断） */
                    "filter[timeTo]"?: components["schemas"]["DateOnly"] & unknown;
                    /** @description 归档年份（C4-07 归档检索；多值逗号分隔，四位年份如 2025,2026；按 projects.archived_at 的 Asia/Shanghai 年判定 —— 未归档项目不命中） */
                    "filter[archivedYear]"?: string;
                    /** @description 关键字（编号 / 名称 / 客户 / 序号） */
                    q?: string;
                    page?: number;
                    limit?: number;
                    /** @description 排序（field:asc|desc）；一期白名单 updatedAt / createdAt / seqNo；缺省 = createdAt:desc（最近创建的在前；Push 175 起默认维度 = 创建时间） */
                    sort?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 项目列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        /** 新建项目（编号由创建人填写；默认按已发布蓝图导入节点） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ProjectCreateBody"];
                };
            };
            responses: {
                /** @description 创建成功 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Project"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/facets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 首页分类计数（与列表同一筛选口径） */
        get: {
            parameters: {
                query?: {
                    /** @description 地区（多值逗号分隔） */
                    "filter[region]"?: string;
                    /** @description 项目类型（多值逗号分隔） */
                    "filter[projectType]"?: string;
                    /** @description 项目经理（多值逗号分隔，UUID）；命中口径（A22 · Push 136）= 项目挂的任意一位经理命中即命中 */
                    "filter[managerId]"?: string;
                    /** @description 阶段 key（多值逗号分隔） */
                    "filter[stageKey]"?: string;
                    /** @description 项目状态（多值逗号分隔） */
                    "filter[status]"?: string;
                    /** @description 项目**创建时间**下界（YYYY-MM-DD，含当日；按 Asia/Shanghai 取当日 00:00:00+08:00；Push 175 起维度 = projects.created_at） */
                    "filter[timeFrom]"?: components["schemas"]["DateOnly"];
                    /** @description 项目**创建时间**上界（YYYY-MM-DD，含当日；按次日 00:00:00+08:00 不含截断） */
                    "filter[timeTo]"?: components["schemas"]["DateOnly"] & unknown;
                    /** @description 归档年份（C4-07 归档检索；多值逗号分隔，四位年份如 2025,2026；按 projects.archived_at 的 Asia/Shanghai 年判定 —— 未归档项目不命中） */
                    "filter[archivedYear]"?: string;
                    /** @description 关键字（编号 / 名称 / 客户 / 序号） */
                    q?: string;
                    page?: number;
                    limit?: number;
                    /** @description 排序（field:asc|desc）；一期白名单 updatedAt / createdAt / seqNo；缺省 = createdAt:desc（最近创建的在前；Push 175 起默认维度 = 创建时间） */
                    sort?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 各维度计数 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectFacets"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 项目详情 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 项目 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Project"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** 删除项目（物理删：连同任务 / 流程节点 / 阶段 / 成员 / 干系人 / 日报 / 问题 / 变更 / 文件；编号随行释放可再建；If-Match 回传当前 version 防误删） */
        delete: {
            parameters: {
                query?: never;
                header: {
                    /** @description 项目当前 version（防误删）；缺失或非数字 → 400 VALIDATION_FAILED，不匹配 → 409 VERSION_CONFLICT */
                    "If-Match": string;
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 已物理删除（删除前快照与子表行数写审计；列表 / 详情 / facets / 搜索不再返回；同编号可再建） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Project"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** 更新项目（乐观锁：必须回传 version） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ProjectUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的项目 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Project"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/projects/{id}/archive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 归档清单（归档时点 + 统计口径 + 文件清单含版本；未归档 404） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 归档记录与清单 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectArchiveView"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        /** 项目归档（门禁：验收阶段完成 + 成果文件齐全性检查；缺项 422 返回清单，confirm=true 确认越过后归档并生成清单） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ProjectArchiveBody"];
                };
            };
            responses: {
                /** @description 归档记录与清单（项目进入只读保护：写路径 409 PROJECT_ARCHIVED） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectArchiveView"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/group": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 项目群绑定状态（未绑定 = bound:false；chatid 掩码回显，activated = 群内已激活） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 群绑定状态（GET 恒 200；项目不存在 / 不可见 = 404） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectGroupBinding"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        /** 绑定 / 换绑项目群（chatid + 可选群名备注；PUT = upsert 覆盖语义；权限 project.update） */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ProjectGroupPutBody"];
                };
            };
            responses: {
                /** @description 绑定后的群状态（chatid 掩码回显） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectGroupBinding"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        post?: never;
        /** 解绑项目群（幂等：未绑定也返回 bound:false；权限 project.update） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 解绑后的群状态（bound:false） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectGroupBinding"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 项目成员名册（记录级权限来源） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 成员列表（项目经理在前，同角色按工号升序） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectMemberListResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        /** 添加 / 更新成员（幂等：同项目 + 同用户唯一） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ProjectMemberCreateBody"];
                };
            };
            responses: {
                /** @description 成员行（重复添加 = 覆盖角色） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectMember"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/members/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 移除成员（返回被移除的成员行；项目归档后拒绝） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    userId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 被移除的成员 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectMember"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 项目总览四格（最慢阶段 / 最新阶段 / 逾期 / 已完成 / 总数） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 总览统计 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectSummary"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 项目任务列表（TaskListItem：表格直接渲染 + 内联摘要） */
        get: {
            parameters: {
                query?: {
                    /** @description 九阶段字典（v0.2 §2.5：售前规划 / 设计开发 / 加工采购 / 组装发货 / 硬件实施 / 软件部署 / 试运行 / 生产阶段 / 验收） */
                    stage?: components["schemas"]["StageKey"];
                    /** @description 任务负责人（单个 UUID）；命中口径（A23 · Push 136）= 该任务挂的任意一位负责人命中即命中 */
                    "filter[ownerId]"?: components["schemas"]["Uuid"] & unknown;
                    /** @description 展示态（多值逗号分隔）：pending / active / done / overdue / early_done */
                    "filter[status]"?: string;
                    /** @description 关键字（中英文任务描述） */
                    q?: string;
                    page?: number;
                    limit?: number;
                    /** @description 排序：sort=field:asc,field2:desc；字段白名单 plannedStart / plannedEnd / actualEnd / progress / title / createdAt（白名单外 400） */
                    sort?: string;
                };
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 任务列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskListResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        /** 创建任务（从任务节点库 / 任务模板生成或手工创建；headcount / priority 可空） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskCreateBody"];
                };
            };
            responses: {
                /** @description 创建成功 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Task"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/tasks/{taskId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 任务详情（抽屉全字段 + 文件清单；列表走 TaskListItem，抽屉打开时按需请求） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    taskId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 任务详情 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskDetail"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** 删除任务（软删：列表 / 看板 / 甘特图 / 完成门禁不可见 + 写留痕；重复删除统一 404；已产生变更记录 409 TASK_HAS_REFERENCES） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    taskId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 删除结果（软删标记） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskDeleteResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** 编辑任务（乐观锁；任务描述 / 成果文件按 A1-17 锁定，进度走 /progress） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    taskId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的任务 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Task"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/projects/{id}/tasks/{taskId}/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新任务进度（联动状态与完成日期，写审计；回退同样留痕） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    taskId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskProgressUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的任务（TaskListItem 同形，前端直接替换行） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskListItem"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/projects/{id}/tasks/{taskId}/can-complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 完成预检（门禁缺件与放行提示；UI 置灰依据，服务端仍在事务内强校验） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    taskId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 预检结果（canComplete + missing + warnings） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskCanCompleteResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/tasks/{taskId}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 任务完成提交（事务内门禁：缺件 422 TASK_REQUIRED_DOC_MISSING；未定档放行 + warning 并触发 R02） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    taskId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskCompleteBody"];
                };
            };
            responses: {
                /** @description 完成结果（task + warnings） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskCompleteResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/tasks/{taskId}/finalize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 任务定档（抽屉开关入口 · Push 252）：未定档 → 置位锁定（此后写口 409 TASK_FINALIZED）；已定档 → 幂等原样返回 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    taskId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskFinalizeBody"];
                };
            };
            responses: {
                /** @description 定档后的任务（Task 同形；幂等路径原样返回） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Task"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/tasks/{taskId}/unfinalize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 任务取消定档（抽屉「已」开关再次点击 · Push 260）：已定档 → 清位重新开放修改（留痕「取消定档」）；未定档 → 幂等原样返回 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    taskId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskUnfinalizeBody"];
                };
            };
            responses: {
                /** @description 取消定档后的任务（Task 同形；幂等路径原样返回） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Task"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/tasks/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 任务批量操作（A1-08：批量指派 / 改状态 / 改日期 / 批量完成；逐条校验 + 部分失败清单） */
        patch: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskBatchBody"];
                };
            };
            responses: {
                /** @description 批量结果（succeeded + failures；部分失败不影响成功项） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskBatchResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/projects/{id}/tasks/{taskId}/locked-fields": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 锁定字段例外调整（仅系统管理员 · A1-17 / C9-07）：任务描述 / 输出成果文件生成后锁定，确需修正时原因必填并留痕（审计 + outbox） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    taskId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskLockedFieldsAdjustBody"];
                };
            };
            responses: {
                /** @description 调整后的任务 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Task"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/projects/{id}/tasks/from-template": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从任务模板批量生成任务（「整套添加」；按节点判重，已存在的跳过） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskCreateFromTemplateBody"];
                };
            };
            responses: {
                /** @description 创建结果（created + skipped） */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskCreateFromTemplateResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/task-nodes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 任务节点库（任务模板的节点来源；按阶段过滤） */
        get: {
            parameters: {
                query?: {
                    /** @description 按阶段过滤；缺省 = 全部阶段 */
                    stage?: components["schemas"]["StageKey"] & unknown;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 节点库列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskNodeListResponse"];
                    };
                };
            };
        };
        put?: never;
        /** 新增任务节点（管理端维护节点库；同阶段同名 409） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskNodeCreateBody"];
                };
            };
            responses: {
                /** @description 创建成功 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskNode"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/task-nodes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 删除任务节点（物理删行；删除前快照写审计；已生成的项目任务不变） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 已删除 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskNodeDeleteResponse"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** 编辑任务节点（改名 / 英文名；乐观锁 version 必传） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskNodeUpdateBody"];
                };
            };
            responses: {
                /** @description 编辑成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskNode"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/task-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 任务模板列表（按阶段过滤；含节点顺序与名称摘要） */
        get: {
            parameters: {
                query?: {
                    /** @description 按阶段过滤；缺省 = 全部阶段 */
                    stage?: components["schemas"]["StageKey"] & unknown;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 模板列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskTemplateListResponse"];
                    };
                };
            };
        };
        put?: never;
        /** 新建任务模板（名称 + 阶段 + 节点顺序） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskTemplateCreateBody"];
                };
            };
            responses: {
                /** @description 创建成功 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskTemplate"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/task-templates/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 模板详情 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 模板 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskTemplate"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** 删除模板（即生效；已生成的项目任务不变） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskTemplateDeleteBody"];
                };
            };
            responses: {
                /** @description 已删除 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskTemplateDeleteResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** 编辑模板（改名 / 节点全量替换；乐观锁） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TaskTemplateUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的模板 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskTemplate"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 用户目录（项目经理下拉 / 任务负责人候选 / 姓名解析；只返回启用用户，默认按工号升序） */
        get: {
            parameters: {
                query?: {
                    /** @description 关键字（工号 / 姓名 / 邮箱） */
                    q?: string;
                    page?: number;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 用户列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UserListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me/preferences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读取当前用户偏好（任务表列显隐（白名单 TaskTableColumnKey）/ 常用筛选 / 醒目模式 / 工作台展开态 / 背景档位 / 卡片水印） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 偏好全量 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UserPreferences"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新当前用户偏好（行锁合并；集合键必须expectedRevisions，缺失400、冲突409） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UserPreferencesUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的偏好全量 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UserPreferences"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/dicts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 全量字典（region / projectType，含元数据 / 主题色与引用计数 usageCount；阶段与成果文件类型走契约枚举，不在字典内） */
        get: {
            parameters: {
                query?: {
                    /** @description 是否包含停用项（缺省 / false = 只见 enabled=true）；true 需要 dict.manage（缺权限 403）；兼容参数，见字段说明 */
                    includeDisabled?: "true" | "false";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 全部字典 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DictListResponse"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/dicts/{type}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 单个字典（未知类型返回 404） */
        get: {
            parameters: {
                query?: {
                    /** @description 是否包含停用项（缺省 / false = 只见 enabled=true）；true 需要 dict.manage（缺权限 403）；兼容参数，见字段说明 */
                    includeDisabled?: "true" | "false";
                };
                header?: never;
                path: {
                    /** @description 字典类型（一期：region / projectType）；未知类型返回 404 */
                    type: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 字典 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Dict"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/dicts/{type}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 新增字典条目（region = 任何登录用户；其余类型 = dict.manage；变更写审计留痕） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description 字典类型（一期：region / projectType）；未知类型返回 404 */
                    type: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["DictItemCreateBody"];
                };
            };
            responses: {
                /** @description 创建成功（更新后的整个字典） */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Dict"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/dicts/{type}/items/{code}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 删除字典条目（物理删除；仅 dict.manage；删除前快照写审计留痕；条目被项目引用时 409 DICT_ITEM_IN_USE） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description 字典类型（一期：region / projectType）；未知类型返回 404 */
                    type: string;
                    code: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 删除成功（更新后的整个字典） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Dict"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** 更新字典条目（部分更新；仅 dict.manage；变更写审计留痕） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description 字典类型（一期：region / projectType）；未知类型返回 404 */
                    type: string;
                    code: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["DictItemUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的整个字典 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Dict"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/audit-logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 审计检索（对象 / 操作人 / 动作 / 结果 / 项目 / 时间区间；仅 audit.view） */
        get: {
            parameters: {
                query?: {
                    /** @description 对象类型（多值逗号分隔，取值见 AuditObjectType） */
                    objectType?: string;
                    /** @description 对象 id（与 objectType 组合 = 按对象检索 —— h7 验收项②） */
                    objectId?: string;
                    /** @description 操作人 users.id（多值逗号分隔，按人检索 —— h7 验收项②） */
                    actorId?: string;
                    /** @description 审计动作（多值逗号分隔，取值见 AuditAction） */
                    action?: string;
                    /** @description 审计结果（多值逗号分隔，取值见 AuditResult）；result=denied 即越权尝试（C7-03） */
                    result?: string;
                    /** @description 所属项目（多值逗号分隔） */
                    projectId?: string;
                    /** @description 关键字：操作内容（摘要 / 字段级修改明细）或操作人姓名快照（包含即命中，大小写不敏感） */
                    q?: string;
                    /** @description 时间下界（含，ISO8601） */
                    from?: components["schemas"]["DateTime"] & unknown;
                    /** @description 时间上界（含，ISO8601） */
                    to?: components["schemas"]["DateTime"] & unknown;
                    /** @description 稳定阅读窗口的最大审计序号；总数仍为当前筛选的总数 */
                    beforeId?: number;
                    page?: number;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 审计列表（occurredAt 降序） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuditLogListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/blueprint": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 当前蓝图（含版本与发布状态；该项目类型尚未建档时 404，default 仅作导入兜底） */
        get: {
            parameters: {
                query?: {
                    /** @description 项目类型（ADR-019）；缺省 = default 兜底模板 */
                    projectType?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 蓝图视图 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BlueprintView"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        /** 保存蓝图草稿（必须通过 schema + 引用校验） */
        put: {
            parameters: {
                query?: {
                    /** @description 项目类型（ADR-019）；缺省 = default 兜底模板 */
                    projectType?: string;
                };
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["BlueprintSaveBody"];
                };
            };
            responses: {
                /** @description 保存后的蓝图视图 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BlueprintView"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/blueprint/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 发布蓝图（递增 blueprintVersion；不影响已生成项目） */
        post: {
            parameters: {
                query?: {
                    /** @description 项目类型（ADR-019）；缺省 = default 兜底模板 */
                    projectType?: string;
                };
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["BlueprintSaveBody"];
                };
            };
            responses: {
                /** @description 发布后的蓝图视图 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BlueprintView"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/blueprint/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 导出蓝图 JSON（自建格式，round-trip 无损） */
        get: {
            parameters: {
                query?: {
                    /** @description 项目类型（ADR-019）；缺省 = default 兜底模板 */
                    projectType?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 蓝图 JSON */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Blueprint"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/blueprint/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 导入蓝图 JSON（保存为草稿；重复导入幂等） */
        post: {
            parameters: {
                query?: {
                    /** @description 项目类型（ADR-019）；缺省 = default 兜底模板 */
                    projectType?: string;
                };
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["BlueprintImportBody"];
                };
            };
            responses: {
                /** @description 导入后的蓝图视图 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BlueprintView"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/flow": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 项目流程（阶段 + 节点 + 约束 + 状态） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 项目流程 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectFlow"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/nodes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 新增节点（一期仅模板节点池；留痕） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["NodeCreateBody"];
                };
            };
            responses: {
                /** @description 新节点 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectNode"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/nodes/{nodeId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 删除节点（软删除 + 留痕；关联成果物时先提示） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    nodeId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["NodeDeleteBody"];
                };
            };
            responses: {
                /** @description 已删除的节点（status=deleted） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProjectNode"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/nodes/{id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 完成节点（服务端事务内过门禁；缺件返回 422 + missing 明细） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["NodeCompleteBody"];
                };
            };
            responses: {
                /** @description 完成后的节点 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["NodeCompleteResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/nodes/{id}/can-complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 完成预检（UI 置灰依据；不替代服务端强校验） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 预检结果 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CanCompleteResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/stages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 项目阶段列表（九阶段状态与完成度；读时派生） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 阶段列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["StageListResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/stages/{key}/advance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 推进阶段（服务端门禁：任务 / 节点 / 成果文件；失败 422 + 缺项明细，不部分推进） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description 九阶段字典（v0.2 §2.5：售前规划 / 设计开发 / 加工采购 / 组装发货 / 硬件实施 / 软件部署 / 试运行 / 生产阶段 / 验收） */
                    key: components["schemas"]["StageKey"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["StageAdvanceBody"];
                };
            };
            responses: {
                /** @description 推进后的阶段列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["StageListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/stages/{key}/rollback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 回退到相邻上一阶段（原因必填并留痕；不做门禁） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description 九阶段字典（v0.2 §2.5：售前规划 / 设计开发 / 加工采购 / 组装发货 / 硬件实施 / 软件部署 / 试运行 / 生产阶段 / 验收） */
                    key: components["schemas"]["StageKey"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["StageRollbackBody"];
                };
            };
            responses: {
                /** @description 回退后的阶段列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["StageListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 项目文件库列表（按类型 / 节点 / 任务 / 状态 / 上传人筛选） */
        get: {
            parameters: {
                query?: {
                    /** @description UUID（主键与关联 ID） */
                    "filter[nodeId]"?: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    "filter[taskId]"?: components["schemas"]["Uuid"];
                    /** @description 文件状态（多值逗号分隔）：draft / final / changed / archived / recycled */
                    "filter[status]"?: string;
                    /** @description 成果文件类型（多值逗号分隔，取值见 DocType 字典） */
                    "filter[docType]"?: string;
                    /** @description UUID（主键与关联 ID） */
                    "filter[uploadedBy]"?: components["schemas"]["Uuid"];
                    /** @description 关键字（文件名） */
                    q?: string;
                    page?: number;
                    limit?: number;
                    /** @description 排序：sort=field:asc,field2:desc（v0.2 §7.1） */
                    sort?: string;
                };
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 文件列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileListResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 发起上传（分片直传；version = 草稿替换 / change = 定档后变更，申请即通过） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UploadCreateBody"];
                };
            };
            responses: {
                /** @description 上传会话（含分片参数；complete 时登记版本） */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UploadCreateResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 文件详情（含当前版本） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 文件详情 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileDetail"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 文件改名（只改元数据名称；乐观锁 version 必传） */
        patch: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["FileRenameBody"];
                };
            };
            responses: {
                /** @description 改名后的文件 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["File"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/files/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 版本链（历史版本可预览 / 下载，受权限控制） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 版本链 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileVersionListResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/versions/{versionId}/download-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 版本短时签名下载（写查看 / 下载审计） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    versionId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 签名下载地址 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileDownloadUrlResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/versions/{versionId}/preview-content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 受控预览内容端点（服务间 · DocServer outbox Bearer JWT；预览链无预签名、无重定向）
         * @description S1 契约切片（ONLYOFFICE 查看器 · 安全定稿 §3.2）：语义 = 交给在线查看器拉取的原文件字节流（不是用户下载口）；鉴权 = 服务间 Bearer JWT（HS256 共享密钥 / payload.url 逐字绑定 / exp ≤ 300s + 容差），缺 token 或不匹配统一 401 且不区分原因；仅 GET（其余方法 405）；不参与用户会话（忽略 Cookie）、不向浏览器来源开 CORS；网关不暴露（仅 DocServer 网段可达）。
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    versionId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 原文件字节流（Content-Type = 版本 mime；Content-Length；Content-Disposition: inline；Cache-Control: no-store；X-Content-Type-Options: nosniff；禁止 302 到预签名 —— 无重定向、不回退预签名） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/octet-stream": string;
                    };
                };
                /** @description 服务间鉴权未通过（缺 / 签名错 / 过期 / URL 绑定不匹配 —— 统一文案不区分原因） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 仅接受 GET（其余方法显式 405，不进业务逻辑） */
                405: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 存储返回异常响应（fail-closed：不重定向、不回退预签名） */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 存储 / 依赖故障（fail-closed：不重定向、不回退预签名） */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/uploads/{uploadId}/parts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 批量获取分片预签名 URL（首传 / 断点续传共用） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    uploadId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UploadPartsBody"];
                };
            };
            responses: {
                /** @description 分片预签名 URL */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UploadPartsResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 上传会话已过期（UPLOAD_SESSION_EXPIRED，需重新发起上传） */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/uploads/{uploadId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 上传会话状态（已传 / 缺失分片；断点续传依据） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    uploadId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 会话状态 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UploadSessionView"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/uploads/{uploadId}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 完成上传（登记 file_version；intent=change 同事务落变更） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    uploadId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UploadCompleteBody"];
                };
            };
            responses: {
                /** @description 文件、版本与（change 意图的）变更记录 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UploadCompleteResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 上传会话已过期（UPLOAD_SESSION_EXPIRED，需重新发起上传） */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/uploads/{uploadId}/abort": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 取消上传会话（未完成分片由对象存储生命周期兜底清理） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    uploadId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 已取消的会话 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UploadAbortResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/finalize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 定档（锁版；此后修改必须走变更） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["FileFinalizeBody"];
                };
            };
            responses: {
                /** @description 已定档的文件 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["File"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/rollback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 回溯生成新版本（不删除历史；定档后按变更流留痕） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["FileRollbackBody"];
                };
            };
            responses: {
                /** @description 回溯后的文件与新版本 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileRollbackResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 业务校验未通过（门禁 / 蓝图校验，含明细） */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/recycle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 移入回收站（默认保留 30 天，可恢复） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["FileRecycleBody"];
                };
            };
            responses: {
                /** @description 已回收的文件 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["File"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复（回到进入前状态） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["FileRestoreBody"];
                };
            };
            responses: {
                /** @description 已恢复的文件 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["File"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除（仅管理员；对象与元数据一并清理，操作留痕） */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
                    "Idempotency-Key"?: components["schemas"]["IdempotencyKey"];
                };
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["FilePurgeBody"];
                };
            };
            responses: {
                /** @description 已彻底删除 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FilePurgeResponse"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{id}/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 预览状态与短时签名地址（D2：异步产物；未就绪 / 失败为 200 语义，not_ready 幂等补投，失败降级「请下载」） */
        get: {
            parameters: {
                query?: {
                    /** @description 指定历史版本（A4-06）；缺省 = 当前版本；不属于该文件 / 不存在 → 404 */
                    versionId?: components["schemas"]["Uuid"] & unknown;
                };
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 预览状态（ready / not_ready / failed） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FilePreviewResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/change-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 变更记录列表（按阶段 / 节点 / 文件 / 申请人 / 关键字检索） */
        get: {
            parameters: {
                query?: {
                    /** @description 阶段（多值逗号分隔） */
                    "filter[stageKey]"?: string;
                    /** @description UUID（主键与关联 ID） */
                    "filter[nodeId]"?: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    "filter[fileId]"?: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    "filter[appliedBy]"?: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    "filter[projectId]"?: components["schemas"]["Uuid"];
                    /** @description 关键字（变更原因 / 变更前后摘要） */
                    q?: string;
                    page?: number;
                    limit?: number;
                    /** @description 排序：sort=field:asc,field2:desc（v0.2 §7.1） */
                    sort?: string;
                };
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 变更记录列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ChangeRequestListResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-requests/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 变更详情（含变更后文件与版本） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 变更详情 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ChangeRequestDetail"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/permissions/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 当前用户授权画像（角色 / 数据范围 / 功能权限位；前端据此置灰） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 授权画像 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PermissionMeResponse"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 登录入口：302 跳转 Casdoor 授权页（PKCE + state；returnTo 为同源回跳路径） */
        get: {
            parameters: {
                query?: {
                    /** @description 登录成功后的回跳路径（仅同源相对路径） */
                    returnTo?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 跳转 SSO 授权页（Set-Cookie: 转场 state / verifier） */
                302: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 登录回调：校验 state + PKCE 换令牌，建立 HttpOnly 会话后 302 回 returnTo */
        get: {
            parameters: {
                query?: {
                    code?: string;
                    state?: string;
                    error?: string;
                    error_description?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 会话建立，跳转应用内路径 */
                302: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description 回调校验失败（AUTH_CALLBACK_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 当前登录用户（会话无效 / 超时返回 401，前端据此重新走 SSO） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 已登录用户 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MeResponse"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 登出：清本地会话并 302 到 Casdoor 单点登出（携 id_token_hint） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 跳转 SSO 登出（本地会话已撤销） */
                302: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/calendar/days": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 某年工作日历：例外清单（放假 / 调休上班）+ 顺延配置（登录即可读） */
        get: {
            parameters: {
                query: {
                    /** @description 公历年份（2000 ~ 2100） */
                    year: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 某年日历 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CalendarYear"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/calendar/day": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 某天的工作日判定（缺省今天；顺延与 T-1/T+1 的输入口径） */
        get: {
            parameters: {
                query?: {
                    /** @description 业务日期 YYYY-MM-DD；缺省 = 今天（Asia/Shanghai） */
                    date?: components["schemas"]["DateOnly"] & unknown;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 某天判定 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CalendarDayView"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/calendar/days/{date}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** 设置某天为放假 / 调休上班（仅管理员 · calendar.manage；幂等 upsert，变更写审计留痕） */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description 业务日期 YYYY-MM-DD（不携带时区） */
                    date: components["schemas"]["DateOnly"] & unknown;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CalendarDayUpsertBody"];
                };
            };
            responses: {
                /** @description 更新后的整年日历 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CalendarYear"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        post?: never;
        /** 删除某天的例外（回落默认规则：周一至周五工作日 / 周六周日非工作日；仅管理员 · calendar.manage） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description 业务日期 YYYY-MM-DD（不携带时区） */
                    date: components["schemas"]["DateOnly"] & unknown;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 更新后的整年日历 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CalendarYear"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/calendar/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 顺延规则配置（D5-02：提醒日期落在非工作日时是否顺延 + 方向；登录即可读） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 顺延配置 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CalendarShiftSettings"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        /** 更新顺延规则（仅管理员 · calendar.manage；变更写审计留痕） */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CalendarSettingsUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的顺延配置 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CalendarShiftSettings"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/calendar/shift": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 顺延求值：非工作日按方向移动到最近工作日（金标：节假日顺延开 / 关两态） */
        get: {
            parameters: {
                query?: {
                    /** @description 业务日期；缺省 = 今天（Asia/Shanghai） */
                    date?: components["schemas"]["DateOnly"] & unknown;
                    /** @description 顺延方向；缺省 = 按日历配置 */
                    direction?: components["schemas"]["CalendarShiftDirection"] & unknown;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 顺延结果 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CalendarShiftResult"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/calendar/offset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** T-N / T+N 求值：自然日偏移 + 可选顺延 + 提醒时刻（如 R03 的「前 1 天 08:00」） */
        get: {
            parameters: {
                query?: {
                    /** @description 基准业务日期（任务的当前日期）；缺省 = 今天（Asia/Shanghai） */
                    date?: components["schemas"]["DateOnly"] & unknown;
                    /** @description 自然日偏移：T-1 = -1，T+1 = +1，T+3 / T+7 同理 */
                    days?: number | null;
                    /** @description 提醒时刻 HH:mm（Asia/Shanghai，如 R03 / R05 的 08:00）；缺省 = 只回业务日期，不回时刻 */
                    time?: string;
                    /** @description 是否顺延：缺省 inherit（按日历配置） */
                    shift?: components["schemas"]["CalendarShiftMode"] & unknown;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description T-N / T+N 结果 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CalendarOffsetResult"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/stakeholders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 干系人台账列表（记录级按数据范围裁剪；隐私字段按字段级策略不返回） */
        get: {
            parameters: {
                query?: {
                    page?: number;
                    limit?: number;
                    /** @description 关键词：姓名 / 公司 / 职务前缀匹配（大小写不敏感） */
                    q?: string;
                    /** @description 公司分类，多值逗号分隔（A5-02） */
                    "filter[companyType]"?: string;
                    /** @description 只看该项目关联的干系人（A5-03 按项目查看联系人清单） */
                    "filter[projectId]"?: components["schemas"]["Uuid"] & unknown;
                    /** @description 排序白名单：updatedAt / createdAt / name；缺省 updatedAt:desc（A5-01 最近更新在前） */
                    sort?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 干系人列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["StakeholderListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        /** 新增干系人（A5-01 / A5-04；stakeholder.manage）：写审计留痕（对象 = stakeholder） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["StakeholderCreateBody"];
                };
            };
            responses: {
                /** @description 新建的干系人 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Stakeholder"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/stakeholders/{stakeholderId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 干系人详情（含关联项目；不可见 / 已删除一律 404，防 IDOR） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    stakeholderId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 干系人详情 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Stakeholder"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** 删除干系人（软删：deleted_at 置位，不物理删行；项目关联保留） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    stakeholderId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 删除结果（deleted 标记） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["StakeholderDeleteResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** 更新干系人（部分更新，null = 清空）：字段级留痕 */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    stakeholderId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["StakeholderUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的干系人 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Stakeholder"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/stakeholders/{stakeholderId}/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 关联项目（A5-03；幂等：已关联返回同一结果）；写审计留痕 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    stakeholderId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["StakeholderProjectLinkBody"];
                };
            };
            responses: {
                /** @description 关联后的干系人 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Stakeholder"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/stakeholders/{stakeholderId}/projects/{projectId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 解除项目关联（A5-03）：未关联 404；写审计留痕 */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    stakeholderId: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    projectId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 解除后的干系人 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Stakeholder"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/reports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 日报列表（A3-01 / A7-02）：日期区间 / 状态 / 提交人筛选 + 分页；日期倒序 */
        get: {
            parameters: {
                query?: {
                    /** @description 日期下界（含） */
                    "filter[dateFrom]"?: components["schemas"]["DateOnly"] & unknown;
                    /** @description 日期上界（含） */
                    "filter[dateTo]"?: components["schemas"]["DateOnly"] & unknown;
                    /** @description 状态多值逗号分隔：draft / submitted / supplement */
                    "filter[state]"?: string;
                    /** @description 提交人 */
                    "filter[authorId]"?: components["schemas"]["Uuid"] & unknown;
                    page?: number;
                    limit?: number;
                };
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 日报列表（项目内成员可见） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DailyReportListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        /** 新建日报（A3-01 / A3-02 · M6-01）：同人同项目同日可多条；对过去日期提交 = 补填；现场发现问题非空且提交 = 自动生成问题（A3-09 幂等） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["DailyReportCreateBody"];
                };
            };
            responses: {
                /** @description 新建的日报 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DailyReport"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/reports/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 当日日报汇总（A7-01）：已提交条目聚合 + 工作日信息；未来日期 400（A02 每日 19:00 群推送的数据面） */
        get: {
            parameters: {
                query?: {
                    /** @description 业务日期 YYYY-MM-DD；缺省 = 今天（Asia/Shanghai）；未来日期 400 */
                    date?: components["schemas"]["DateOnly"] & unknown;
                };
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 当日汇总（项目内成员可见） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DailyReportSummary"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/reports/missing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 当日应填未填清单（A7-05）：项目名册 × 工作日历 × 当日未提交（草稿不计已填）；非工作日整列为空；未来日期 400 */
        get: {
            parameters: {
                query?: {
                    /** @description 业务日期 YYYY-MM-DD；缺省 = 今天（Asia/Shanghai）；未来日期 400 */
                    date?: components["schemas"]["DateOnly"] & unknown;
                };
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 当日应填未填清单（项目内成员可见） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DailyReportMissing"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/reports/{reportId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 日报详情（A3-01 全字段 + 关联任务标题） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    reportId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 日报详情 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DailyReport"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** 删除日报（成对删除：删日报 = 连它派生的全部问题 + 两侧附图关联；写审计与 outbox） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    reportId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 删除结果（cascadedIssueIds 为连带删除的问题） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DailyReportDeleteResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** 编辑 / 提交日报（A3-02 草稿提交）：乐观锁 version；date 不可改；已提交行不允许退回草稿 */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    reportId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["DailyReportUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的日报 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DailyReport"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/projects/{id}/issues": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 问题列表（A3-16 问题追踪 / 问题看板同源）：状态 / 归类 / 任务 / 来源日报筛选 + 关键字 + 分页；提出日期倒序 */
        get: {
            parameters: {
                query?: {
                    /** @description 状态多值逗号分隔：open / in_progress / done */
                    "filter[state]"?: string;
                    /** @description 归类筛选（C9 十项；命中任一归类即入选） */
                    "filter[category]"?: string;
                    /** @description 所属任务 */
                    "filter[taskId]"?: components["schemas"]["Uuid"] & unknown;
                    /** @description 来源日报 */
                    "filter[reportId]"?: components["schemas"]["Uuid"] & unknown;
                    /** @description 关键字（问题描述） */
                    q?: string;
                    page?: number;
                    limit?: number;
                };
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 问题列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["IssueListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{id}/issues/{issueId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 问题详情（A3-13）：问题本体 + 处理过程留痕（时间正序） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    issueId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 问题详情 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["IssueDetail"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** 删除问题（成对删除：删问题 = 连它来源的那篇日报及其全部问题；写审计与 outbox） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    issueId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 删除结果（cascadedReportId 为连带删除的来源日报） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["IssueDeleteResponse"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** 问题更新（A3-10 三态流转 / A3-12 分派 / A3-13 解决方案 / 描述与归类行内编辑 / 附图）：乐观锁 version；允许回退且留痕（done → 其它态一并清 closed_at） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                    /** @description UUID（主键与关联 ID） */
                    issueId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["IssueUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的问题详情 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["IssueDetail"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 冲突（VERSION_CONFLICT / 状态不允许当前操作） */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/workspace": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 工作台（M6-05）：我的任务四组（今日待办 / 即将到期 / 已逾期 / 未排期）+ 我的问题（我处理 / 我提出的） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 工作台聚合（按会话用户；记录级可见性过滤后） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["WorkspaceResponse"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/views": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 视图清单（A1-03 · M2-06）：我的个人视图 + 全部公共视图；scope 过滤；排序个人在前 → 更新时间降序 → id 升序 */
        get: {
            parameters: {
                query?: {
                    /** @description 范围过滤：personal = 我的个人视图；public = 公共视图；缺省 = 我的个人视图 + 全部公共视图 */
                    scope?: components["schemas"]["ViewScope"] & unknown;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 可见视图清单（无分页：量级小） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ViewListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        /** 新建视图（A1-03 首刀）：仅保存配置（筛选 + 列 + 排序 + 分组）、不复制数据；isDefault 置位时自动清掉本人其它默认 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ViewCreateBody"];
                };
            };
            responses: {
                /** @description 新建的视图 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SavedView"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/views/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 删除视图（物理删）：个人视图他人 404；公共视图非创建者 403 */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 删除结果 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ViewDeleteResponse"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** 更新视图（局部更新：只传变更键，空更新 400）：个人视图他人 404；公共视图非创建者 403；无乐观锁（单写者） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description UUID（主键与关联 ID） */
                    id: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ViewUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的视图 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SavedView"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 无权限（FORBIDDEN） */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/follows": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 我的关注清单（A1-15 · M2-06）：按对象类型 / 对象 / 项目过滤；不可见或已删对象不返回；时间降序 → id 升序 */
        get: {
            parameters: {
                query?: {
                    /** @description 关注对象类型：project 项目 / task 任务 */
                    objectType?: components["schemas"]["FollowObjectType"];
                    /** @description 按对象过滤（配合 objectType；用于任务详情判断是否已关注） */
                    objectId?: components["schemas"]["Uuid"] & unknown;
                    /** @description 按项目过滤（含该项目下的任务关注） */
                    projectId?: components["schemas"]["Uuid"] & unknown;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 我的关注清单 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FollowListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        /** 关注（A1-15）：目标须可见且未删除（归档项目不可新关注）；重复关注幂等（created=false → 200） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["FollowCreateBody"];
                };
            };
            responses: {
                /** @description 已关注（幂等回读） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FollowCreateResponse"];
                    };
                };
                /** @description 新建的关注关系 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FollowCreateResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/follows/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 批量关注 / 取关（A1-15，1 ~ 50 条）：单事务逐条独立；失败仅关注动作的 not_found（取关不存在的行 = unchanged） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["FollowBatchBody"];
                };
            };
            responses: {
                /** @description 批量结果（失败明细内联） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FollowBatchResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/follows/{objectType}/{objectId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 取关（按关系键删除，不校验目标是否可见 / 存在）；未关注 = 404 */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description 关注对象类型：project 项目 / task 任务 */
                    objectType: components["schemas"]["FollowObjectType"];
                    /** @description UUID（主键与关联 ID） */
                    objectId: components["schemas"]["Uuid"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 取关结果 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FollowDeleteResponse"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 收件箱清单（C5-01 / C5-02）：状态 / 类型 / 关联对象 + 投递时刻区间 + 分页；只返回已投递主行（合并子行仅在库内留档）；随行未读角标计数 */
        get: {
            parameters: {
                query?: {
                    /** @description 状态过滤（缺省 = 全部三态） */
                    status?: components["schemas"]["NotificationStatus"] & unknown;
                    /** @description 类型过滤（C5-02 分类；缺省 = 全部） */
                    type?: components["schemas"]["NotificationType"] & unknown;
                    /** @description 关联对象类型过滤（如 task / issue；缺省 = 全部） */
                    refType?: string;
                    /** @description 投递时刻下界（含；缺省 = 不限） */
                    from?: components["schemas"]["DateTime"] & unknown;
                    /** @description 投递时刻上界（含；缺省 = 不限） */
                    to?: components["schemas"]["DateTime"] & unknown;
                    page?: number;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 收件箱清单（含未读计数） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["NotificationListResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 标记收件箱状态（C5-01 未读 / 已读 / 已处理）：幂等；仅本人可标记（他人 404 防 IDOR） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["NotificationMarkBody"];
                };
            };
            responses: {
                /** @description 标记后的通知 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Notification"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/notifications/mark-all-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 全部标记已读（C5-01）：本人未读主行一次性置为已读；幂等（无未读时 updated=0） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 置位结果（updated / unreadCount=0） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["NotificationMarkAllReadResponse"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/prefs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 通知偏好（C2-09）：免打扰时段 / 每日上限 / 合并窗口 —— 读面为生效值（个人配置缺省时回退 env 缺省） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 生效中的通知偏好 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["NotifyPrefs"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新通知偏好（局部更新：只传变更键；免打扰两键成对，双 null = 关闭；空更新 400；null = 恢复缺省） */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["NotifyPrefsUpdateBody"];
                };
            };
            responses: {
                /** @description 更新后的生效偏好 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["NotifyPrefs"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/notifications/stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 通知及业务同步流（SSE）：事件 notification（单条通知）/ unread（未读角标）/ invalidate（资源类别失效提示，无业务数据）；心跳注释行不入契约；重连不补发（客户端读面补拉对齐；Last-Event-ID 补发留二期） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description SSE 事件流（text/event-stream）：event: notification → data = Notification；event: unread → data = { unreadCount }；event: invalidate → data = { resources: 资源类别[] }；心跳 = 注释行（: ping，周期落 env）；服务优雅关闭先发注释行告知（客户端自动重连） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/event-stream": string;
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{id}/snooze": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 设置稍后提醒（C5-05）：绝对时刻（now + 5 分钟 ~ now + 30 天）；设置即置读；重复设置 = 覆盖（旧记录标 cancelledAt + 写新记录） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["NotificationSnoozeBody"];
                };
            };
            responses: {
                /** @description 设置后的通知（snoozeUntil 已更新、该行置读） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Notification"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        /** 取消稍后提醒（C5-05）：幂等（无未触发稍后提醒也 200）；返回更新后的通知（snoozeUntil = null） */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 取消后的通知（snoozeUntil = null） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Notification"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{id}/snoozes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 稍后提醒记录（C5-05「设置与触发记录可查」）：一次设置一条（触发 / 取消回填时刻）；按 id 降序，不翻页 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 稍后提醒记录清单 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["NotificationSnoozeListResponse"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 资源不存在或不可见（NOT_FOUND，统一 404 语义） */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/wecom-dm-binding": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 企业微信单聊绑定态（D5 / D6 设置页）：按当前机器人（`WECOM_BOT_ID`）维度判定；恒 200（未绑定 = bound:false）；企微 open_userid 只回掩码末 4 位；v1.8 另回当前未用绑定码（bindingCode）与取码限流可重试时刻（retryAt）—— 页面刷新不丢码面 / 倒计时 / 罚时 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 绑定态（未绑定 = bound:false；wecomUseridMasked / boundAt = null） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["WecomDmBindingState"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** 解绑企业微信单聊（D6）：注销投递资格（保留激活登记）→ 未绑定态收口（不发帧 + dead + 绑定指引降级）；幂等（未绑定也 200 bound:false，不写审计）；解绑成功写 audit_logs */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 解绑后的绑定态（恒 bound:false） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["WecomDmBindingState"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/wecom-dm-binding/codes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 生成绑定码（D3 / D5）：6 位数字 · TTL 5 分钟 · 一次性 · 5 次 / 3 分钟 / 用户（D3 修订 v1.8 —— 超出 429 RATE_LIMITED）；重复取码作废上一条未用码；用户把码发进企微单聊即绑定（v1.8：以码持有者为准换绑 · 会话内回执由 worker 承担） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 绑定码（code / expiresAt / expiresInSeconds） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["WecomDmBindingCode"] & unknown;
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 取码频率到顶（RATE_LIMITED；details[0].meta.retryAt = 可重试时刻，meta.window = 3m） */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/translate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 单条翻译（译文库优先）：命中直出；未命中调内网引擎（HY-MT1.5-1.8B）后落库 —— 引擎不可用 500 INTERNAL（前端静默降级跳过） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TranslateBody"];
                };
            };
            responses: {
                /** @description 译文（库内或引擎产出，产出即落库） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TranslateResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 翻译引擎不可用（INTERNAL；前端静默降级跳过） */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/translate/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 批量查库（不调引擎）：一次请求拿整页已存译文（英文界面切页提速）；未命中条目由前端走单条通道 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TranslateBatchBody"];
                };
            };
            responses: {
                /** @description 命中条目清单 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TranslateBatchResponse"];
                    };
                };
                /** @description 契约校验失败（VALIDATION_FAILED） */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                /** @description 未认证（AUTH_REQUIRED） */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @description 当前用户授权画像（角色 + 数据范围 + 功能权限位） */
        ActorPermissions: {
            userId: components["schemas"]["Uuid"];
            /**
             * @description 角色码（roles.code；多角色并集）
             * @example [
             *       "project_manager"
             *     ]
             */
            roleCodes: string[];
            /** @description 数据范围并集（由宽到窄） */
            dataScopes: components["schemas"]["DataScope"][];
            /** @description 功能权限位并集（role_permissions） */
            permissionKeys: components["schemas"]["PermissionKey"][];
        };
        /** @description 统一错误信封（技术设计v0.2 §7.2） */
        ApiError: {
            code: components["schemas"]["ErrorCode"];
            /** @example 参数校验失败 */
            message: string;
            /** @default [] */
            details: components["schemas"]["ErrorDetail"][];
            /** @example 4f1c2f2e-6f8a-4b1e-9a1f-2f6d6f2c9d10 */
            traceId: string;
        };
        /**
         * @description 审计动作：create 新增 / update 修改 / delete 删除 / progress 进度 / complete 节点完成 / advance 阶段推进 / rollback 阶段回退 / archive 项目归档（ADR-027：归档动作写审计，确认越过的缺项计数记 metadata）/ preview 预览查看（**已停用 · 2026-10-12**：操作日志不再记录预览动作 —— 值保留供历史行回读 / 筛选，服务端不再产生新行） / download 离线下载（A4-10：下载受 file.download 权限点控制并写日志；对象类型 file，经 metadata 记 versionId） / deny 越权拒绝
         * @enum {string}
         */
        AuditAction: "create" | "update" | "delete" | "progress" | "complete" | "advance" | "rollback" | "archive" | "preview" | "download" | "deny";
        /** @description 字段级修改条目（C7-02） */
        AuditChange: {
            /** @description 字段名（契约口径 camelCase） */
            field: string;
            /** @description 修改前值（JSON；无值时为 null） */
            from?: unknown;
            /** @description 修改后值（JSON；无值时为 null） */
            to?: unknown;
        };
        /**
         * @description 审计入口：api / page / system / batch
         * @enum {string}
         */
        AuditEntry: "api" | "page" | "system" | "batch";
        /** @description 审计日志（C7）：追加写、不可改删、保留 ≥6 个月（C7-05） */
        AuditLog: {
            /** @description 审计序号（只增不减） */
            id: number;
            occurredAt: components["schemas"]["DateTime"];
            actorId: components["schemas"]["Uuid"] & (string | null);
            /** @description 操作人姓名快照（写入时冗余，改名后仍可追溯） */
            actorName: string | null;
            action: components["schemas"]["AuditAction"];
            objectType: components["schemas"]["AuditObjectType"];
            /** @description 对象 id（uuid 或字典码等业务键） */
            objectId: string;
            projectId: components["schemas"]["Uuid"] & (string | null);
            result: components["schemas"]["AuditResult"];
            entry: components["schemas"]["AuditEntry"];
            /** @description 可读摘要（列表直接展示） */
            summary: string;
            /** @description 字段级修改（C7-02）；无字段级变化时为 null */
            changes: components["schemas"]["AuditChange"][] | null;
            /** @description 附加信息（trace_id / 请求方法路径等） */
            metadata: {
                [key: string]: unknown;
            };
        };
        AuditLogListResponse: {
            items: components["schemas"]["AuditLog"][];
            page: number;
            limit: number;
            total: number;
            /** @description 该阅读窗口的最大审计序号，自动回读通过beforeId保持历史页稳定 */
            windowId: number | null;
        };
        /**
         * @description 审计对象类型：project 项目 / project_member 名册 / task 任务 / node 节点 / stage 阶段 / dict_item 字典条目 / blueprint 蓝图 / calendar_day 日历例外（对象 id = 业务日期） / calendar_settings 顺延配置（对象 id = default） / file 文件（对象 id = fileId；上传会话事件经 metadata.uploadId 定位；预览事件自 2026-10-12 起不再写审计 —— 不为同一 fileId 开第二种对象类型） / change 变更记录（对象 id = changeRequestId，M4-04） / stakeholder 干系人（对象 id = stakeholderId；项目关联 / 解除经 metadata.projectId 记录，j6） / daily_report 日报（对象 id = reportId，M6-01 / M6-02） / issue 问题（对象 id = issueId，M6-02 / M6-03） / task_node 任务节点（对象 id = taskNodeId，M3-05 余：节点库新增 / 编辑 / 删除） / task_template 任务模板（对象 id = templateId，M3-05 余第二段：模板新增 / 编辑 / 软删） / user 系统用户（对象 id = users.id；Push 173：离职回收 / 组织同步的停用 · 启用 · 软删）
         * @enum {string}
         */
        AuditObjectType: "project" | "project_member" | "task" | "node" | "stage" | "dict_item" | "blueprint" | "calendar_day" | "calendar_settings" | "file" | "change" | "stakeholder" | "daily_report" | "issue" | "task_node" | "task_template" | "user";
        /**
         * @description 审计结果：succeeded 成功 / denied 越权尝试（C7-03）/ failed 业务拒绝（门禁等）
         * @enum {string}
         */
        AuditResult: "succeeded" | "denied" | "failed";
        /**
         * @description 背景档位（Push 291 · 顶栏「背景 · 档位」；Push 313 起默认 medium）：simple = 简约 / medium = 适中（默认）/ vivid = 炫彩；读侧白名单外 / 缺省一律收敛为 medium
         * @enum {string}
         */
        BackgroundTier: "simple" | "medium" | "vivid";
        /** @description 自建蓝图 JSON（v0.2 §3.2 + ADR-019）；导入校验 = schema + 引用 + 幂等 */
        Blueprint: {
            /** @enum {number} */
            schemaVersion: 1;
            blueprintVersion: number;
            name: string;
            /** @description 所属项目类型（ADR-019：按项目类型各一份，default 为兜底模板）；缺省 = 通用 */
            projectType?: string;
            updatedAt: components["schemas"]["DateTime"];
            stages: components["schemas"]["BlueprintStage"][];
        };
        BlueprintConstraint: components["schemas"]["BlueprintRequiredDocConstraint"] | components["schemas"]["BlueprintReservedConstraint"];
        /** @description 导入自建蓝图 JSON（保存为草稿；重复导入幂等） */
        BlueprintImportBody: {
            blueprint: components["schemas"]["Blueprint"];
        };
        /** @description 每个节点至少一类约束（校验规则见 v0.2 §3.4） */
        BlueprintNode: {
            /**
             * @description 节点稳定键；一经发布不可改名（改名 = 新增 + 废弃）
             * @example design.mech
             */
            key: string;
            /** @example 机械设计图纸 */
            name: string;
            /** @description 排序（建议 10/20/30 步长，便于插入） */
            seq: number;
            /** @default [] */
            constraints: components["schemas"]["BlueprintConstraint"][];
        };
        /** @description 必交成果物（一期门禁实现的唯一约束类型） */
        BlueprintRequiredDocConstraint: {
            /** @enum {string} */
            type: "required_doc";
            docType: components["schemas"]["DocType"];
            /** @default 1 */
            minCount: number;
        };
        /** @description 预留约束类型（结构就位、规则后置） */
        BlueprintReservedConstraint: {
            /** @enum {string} */
            type: "field" | "dependency" | "deadline";
            /** @default {} */
            config: {
                [key: string]: unknown;
            };
        };
        /** @description 保存蓝图草稿（必须通过 schema + 引用校验） */
        BlueprintSaveBody: {
            blueprint: components["schemas"]["Blueprint"];
        };
        BlueprintStage: {
            key: components["schemas"]["StageKey"];
            name: string;
            seq: number;
            nodes: components["schemas"]["BlueprintNode"][];
        };
        /**
         * @description 蓝图状态：发布产生新版本，不自动影响已生成项目（快照）
         * @enum {string}
         */
        BlueprintStatus: "draft" | "published";
        BlueprintView: {
            blueprint: components["schemas"]["Blueprint"];
            status: components["schemas"]["BlueprintStatus"];
            /** @description 所属项目类型（ADR-019） */
            projectType: string;
            /** @description 是否兜底默认模板（project_type = default） */
            isDefault: boolean;
            /** @description 已发布版本号（0 = 尚未发布） */
            publishedVersion: number;
            publishedAt: components["schemas"]["DateTime"] & (string | null);
            publishedBy: components["schemas"]["Uuid"] & (string | null);
        };
        /** @description 日历例外条目；维护动作写审计留痕（object_type = calendar_day） */
        CalendarDay: {
            date: components["schemas"]["DateOnly"] & unknown;
            dayType: components["schemas"]["CalendarDayType"];
            /** @description 名称（如「国庆节」「春节调休上班」）；可空 */
            name: string | null;
            /** @description 说明 / 来源（可空） */
            note: string | null;
            updatedAt: components["schemas"]["DateTime"];
            updatedBy: components["schemas"]["Uuid"] & (string | null);
        };
        /**
         * @description 日期判定结果：workday 工作日 / weekend 周末 / holiday 放假 / makeup_workday 调休上班（isWorkday 为 false 的三种一律参与顺延判断）
         * @enum {string}
         */
        CalendarDayKind: "workday" | "weekend" | "holiday" | "makeup_workday";
        /**
         * @description 日历例外类型：holiday 放假 / makeup_workday 调休上班（周末补班）；未登记的日期按默认规则判定
         * @enum {string}
         */
        CalendarDayType: "holiday" | "makeup_workday";
        /** @description 设置某天为放假 / 调休上班（幂等）：变更写审计留痕；响应为更新后的整年日历 */
        CalendarDayUpsertBody: {
            dayType: components["schemas"]["CalendarDayType"];
            /** @description 名称（如「国庆节」）；不传则保持原值（新建时可空） */
            name?: string;
            /** @description 说明 / 来源；不传则保持原值 */
            note?: string;
        };
        /** @description 某一天的工作日判定（登录即可读，D5-03 为规则引擎提供日期依据） */
        CalendarDayView: {
            date: components["schemas"]["DateOnly"] & unknown;
            kind: components["schemas"]["CalendarDayKind"];
            isWorkday: boolean;
            name: string | null;
            note: string | null;
            /**
             * @description 判定来源：calendar = 命中例外表 / default = 默认规则（周末或普通工作日）
             * @enum {string}
             */
            source: "default" | "calendar";
        };
        /** @description T-N / T+N 求值结果（业务日期 + 可选时刻；跨年自动扩窗） */
        CalendarOffsetResult: {
            baseDate: components["schemas"]["DateOnly"] & unknown;
            days: number;
            time: string | null;
            shift: components["schemas"]["CalendarShiftMode"];
            rawDate: components["schemas"]["DateOnly"] & unknown;
            date: components["schemas"]["DateOnly"] & unknown;
            shifted: boolean;
            shiftDirection: components["schemas"]["CalendarShiftDirection"] & (string | null);
            kind: components["schemas"]["CalendarDayKind"];
            name: string | null;
            at: components["schemas"]["DateTime"] & (string | null);
        };
        /** @description 更新顺延规则（只传变更键）：变更写审计留痕 */
        CalendarSettingsUpdateBody: {
            reminderShiftEnabled?: boolean;
            shiftDirection?: components["schemas"]["CalendarShiftDirection"];
        };
        /**
         * @description 顺延方向：forward 顺延到之后最近工作日（节假日期间不提醒，节后补） / backward 提前到之前最近工作日（节前提醒）
         * @enum {string}
         */
        CalendarShiftDirection: "forward" | "backward";
        /**
         * @description 顺延开关：inherit 按日历配置（缺省） / on 本次强制顺延 / off 本次强制不顺延
         * @enum {string}
         */
        CalendarShiftMode: "inherit" | "on" | "off";
        /** @description 顺延求值结果：基准日状态 + 顺延去向 + 跳过的非工作日 */
        CalendarShiftResult: {
            baseDate: components["schemas"]["DateOnly"] & unknown;
            direction: components["schemas"]["CalendarShiftDirection"];
            date: components["schemas"]["DateOnly"] & unknown;
            shifted: boolean;
            /** @description 被跳过的非工作日（按移动顺序；未顺延为空） */
            skipped: (components["schemas"]["DateOnly"] & unknown)[];
            baseKind: components["schemas"]["CalendarDayKind"] & unknown;
            /** @description 基准日期是否工作日（false = 本次发生了顺延 / 提前） */
            baseIsWorkday: boolean;
            kind: components["schemas"]["CalendarDayKind"] & unknown;
            /** @description 结果日期命中的例外名称（可空） */
            name: string | null;
        };
        /** @description 顺延规则配置（单行）：是否顺延 + 顺延方向 */
        CalendarShiftSettings: {
            /** @description 提醒日期落在非工作日时是否顺延（可配置，D5-02） */
            reminderShiftEnabled: boolean;
            shiftDirection: components["schemas"]["CalendarShiftDirection"];
            updatedAt: components["schemas"]["DateTime"];
            updatedBy: components["schemas"]["Uuid"] & (string | null);
        };
        /** @description 某年工作日历（例外清单 + 顺延配置） */
        CalendarYear: {
            year: number;
            /** @description 该年例外清单（放假 / 调休上班），按日期升序；未列出的日期按默认规则 */
            days: components["schemas"]["CalendarDay"][];
            settings: components["schemas"]["CalendarShiftSettings"];
        };
        /** @description 完成预检（UI 置灰依据；服务端仍在事务内强校验） */
        CanCompleteResponse: {
            canComplete: boolean;
            missing: components["schemas"]["NodeGateMissing"][];
        };
        /** @description 变更申请字段（随上传会话提交，完成上传时同事务生效） */
        ChangeIntentBody: {
            /** @description 变更原因（必填；无变更后文件不允许提交） */
            reason: string;
            beforeSummary?: string;
            afterSummary?: string;
            /** @description 变更前摘要附图（文件 id 有序，≤ 30；须为本项目未回收文件，否则 400 VALIDATION_FAILED） */
            beforeSummaryFileIds?: components["schemas"]["Uuid"][];
            /** @description 变更后摘要附图（文件 id 有序，≤ 30；同左口径） */
            afterSummaryFileIds?: components["schemas"]["Uuid"][];
            stageKey?: components["schemas"]["StageKey"];
        };
        /** @description intent=change 时的变更记录；version 意图为空 */
        ChangeRequest: {
            id: components["schemas"]["Uuid"];
            projectId: components["schemas"]["Uuid"];
            nodeId: components["schemas"]["Uuid"] & (string | null);
            stageKey: components["schemas"]["StageKey"] & (string | null);
            /** @description 变更原因（必填） */
            reason: string;
            /** @description 变更前摘要 */
            beforeSummary: string | null;
            /** @description 变更后摘要 */
            afterSummary: string | null;
            /** @description 变更前摘要附图（文件 id 有序；Push 314 变更前后可填图） */
            beforeSummaryFileIds: components["schemas"]["Uuid"][];
            /** @description 变更后摘要附图（文件 id 有序；Push 314 变更前后可填图） */
            afterSummaryFileIds: components["schemas"]["Uuid"][];
            status: components["schemas"]["ChangeStatus"];
            appliedBy: components["schemas"]["Uuid"];
            writerBy: components["schemas"]["Uuid"] & (string | null);
            appliedAt: components["schemas"]["DateTime"];
            createdAt: components["schemas"]["DateTime"];
            fileId: components["schemas"]["Uuid"] & (string | null);
            versionId: components["schemas"]["Uuid"] & (string | null);
            /** @description 变更后版本号；导入遗留变更 = null */
            versionSeq: number | null;
        } | null;
        /** @description 变更记录（v0.2 §5.3；一期申请即通过、全程留痕） */
        ChangeRequestDetail: components["schemas"]["ChangeRequest"] & {
            file: components["schemas"]["File"] & (Record<string, never> | null);
            version: components["schemas"]["FileVersion"];
            /** @description 变更前文件名称（Push 256：本次变更同时更名 —— name/扩展名随变更文件替换时 = 更名前名称；未更名 = null） */
            filePreviousName: string | null;
        };
        ChangeRequestListResponse: {
            items: (components["schemas"]["ChangeRequest"] & unknown)[];
            page: number;
            limit: number;
            total: number;
        };
        /**
         * @description 变更申请状态；一期申请即通过（唯一终态 applied），多级审批二期可启用
         * @enum {string}
         */
        ChangeStatus: "applied";
        /** @description 一条日报（A3-01 全字段 + 系统字段） */
        DailyReport: {
            id: components["schemas"]["Uuid"];
            projectId: components["schemas"]["Uuid"];
            authorId: components["schemas"]["Uuid"];
            /** @description 提交人显示名（A3-01 系统字段） */
            authorName: string | null;
            date: components["schemas"]["DateOnly"] & unknown;
            state: components["schemas"]["DailyReportState"];
            /** @description 今日施工人数（A3-03 默认带上次填报值，可修改） */
            headcount: number | null;
            /** @description 当日完成工作（A3-04 必填；原「回写关联任务进展」（A3-08）随关联单位改阶段停用 —— Push 215） */
            doneWork: string;
            /** @description 明日计划 */
            plan: string | null;
            /** @description 现场发现问题（非空 → 提交时自动生成问题，A3-09 幂等） */
            foundIssue: string | null;
            /** @description 问题归类（多值，C9 十项；「现场发现问题」非空时 ≥1 项，A3-04） */
            issueCategories: components["schemas"]["IssueCategory"][];
            /** @description 解决方案或建议 */
            suggestion: string | null;
            /** @description 关联阶段（A3-03 多选，九阶段字典；原「关联任务」Push 198 改口径，A3-08 回写停用） */
            stageKeys: components["schemas"]["StageKey"][];
            /** @description 关联阶段名（与 stageKeys 同下标，查 STAGE_NAMES 展示） */
            stageNames: string[];
            /** @description 现场工作附图（file_links(object_type=report, kind=onsite)）；可增删 */
            photos: components["schemas"]["FilePhotoRef"][];
            /** @description 当前问题附图（file_links(object_type=report, kind=issue)）；提交生成问题时转挂到问题（file_links(object_type=issue)），转挂后此处为空 */
            issuePhotos: components["schemas"]["FilePhotoRef"][];
            submittedAt: components["schemas"]["DateTime"] & (string | null);
            createdAt: components["schemas"]["DateTime"];
            updatedAt: components["schemas"]["DateTime"];
            version: components["schemas"]["Version"];
        };
        /** @description 新报一天日报（草稿 / 提交）；补填由服务端按日期推导 */
        DailyReportCreateBody: {
            date: components["schemas"]["DateOnly"] & unknown;
            state?: components["schemas"]["DailyReportWriteState"];
            /** @description 今日施工人数（缺省为空） */
            headcount?: number;
            /** @description 当日完成工作（A3-04 必填） */
            doneWork: string;
            /** @description 明日计划 */
            plan?: string;
            /** @description 现场发现问题（非空时问题归类必填；提交时自动生成问题，A3-09） */
            foundIssue?: string;
            /** @description 问题归类（多值，C9 十项；「现场发现问题」非空时必填 ≥1 项） */
            issueCategories?: components["schemas"]["IssueCategory"][];
            /** @description 解决方案或建议 */
            suggestion?: string;
            /** @description 关联阶段（A3-03 多选，九阶段字典；须为合法阶段键） */
            stageKeys?: components["schemas"]["StageKey"][];
            /** @description 现场工作附图（文件 id 整体替换；须为本项目已上传文件，上限 30 张） */
            photoFileIds?: components["schemas"]["Uuid"][];
            /** @description 当前问题附图（文件 id 整体替换；提交生成问题时转挂到问题） */
            issuePhotoFileIds?: components["schemas"]["Uuid"][];
            /** @description 内联问题清单（1~N 条；与 foundIssue / issueCategories / suggestion / issuePhotoFileIds 互斥 —— 二选一） */
            issues?: components["schemas"]["ReportIssueDraft"][];
        };
        /** @description 日报删除（成对删除派生问题） */
        DailyReportDeleteResponse: {
            id: components["schemas"]["Uuid"];
            /** @enum {boolean} */
            deleted: true;
            /** @description 连带删除的问题（删日报 = 连它派生的全部问题） */
            cascadedIssueIds: components["schemas"]["Uuid"][];
        };
        /** @description 日报列表（项目内成员可见） */
        DailyReportListResponse: {
            items: components["schemas"]["DailyReport"][];
            page: number;
            limit: number;
            total: number;
        };
        /** @description 当日应填未填清单（A7-05：项目成员 × 工作日历 × 当日未提交） */
        DailyReportMissing: {
            date: components["schemas"]["DateOnly"] & unknown;
            /** @description 当日是否工作日（日历例外优先，D5-03 同口径） */
            isWorkday: boolean;
            dayKind: components["schemas"]["CalendarDayKind"];
            /** @description 日历例外名称（如「国庆节」）；无例外为 null */
            dayName: string | null;
            /** @description 项目名册人数 */
            memberCount: number;
            /** @description 当日已提交（submitted / supplement）人数 */
            submittedCount: number;
            /** @description 仅有草稿（未提交）的人数 */
            draftCount: number;
            /** @description 应填未填人数（非工作日为 0） */
            missingCount: number;
            /** @description 项目名册全员（按名册顺序） */
            members: components["schemas"]["DailyReportRosterEntry"][];
            /** @description 应填未填人 id（非工作日为空数组；顺序同名册） */
            missingUserIds: components["schemas"]["Uuid"][];
        };
        /** @description 名册成员当日填报状态（A7-05 应填未填的一行） */
        DailyReportRosterEntry: {
            userId: components["schemas"]["Uuid"];
            /** @description 登录名 / 工号 */
            username: string | null;
            /** @description 显示名 */
            displayName: string | null;
            roleInProject: components["schemas"]["ProjectMemberRole"];
            reportId: components["schemas"]["Uuid"] & (string | null);
            state: components["schemas"]["DailyReportState"] & (string | null);
            submittedAt: components["schemas"]["DateTime"] & (string | null);
        };
        /**
         * @description 日报状态（A3-02）：draft 草稿 / submitted 已提交 / supplement 补填（对过去日期首次提交）
         * @enum {string}
         */
        DailyReportState: "draft" | "submitted" | "supplement";
        /** @description 当日日报汇总（A7-01） */
        DailyReportSummary: {
            date: components["schemas"]["DateOnly"] & unknown;
            isWorkday: boolean;
            dayKind: components["schemas"]["CalendarDayKind"];
            dayName: string | null;
            /** @description 已提交（submitted / supplement）条目数 */
            entryCount: number;
            /** @description 草稿条目数（不计入汇总正文） */
            draftCount: number;
            /** @description 今日施工人数合计（未填按 0 计） */
            headcountTotal: number;
            /** @description 「现场发现问题」非空的条目数 */
            issueCount: number;
            /** @description 已提交条目（提交时间升序，同刻按创建时间、作者 id 兜底；同日多条逐条列出） */
            entries: components["schemas"]["DailyReport"][];
        };
        /** @description 编辑日报（乐观锁 version；date 不可改） */
        DailyReportUpdateBody: {
            version: components["schemas"]["Version"];
            state?: components["schemas"]["DailyReportWriteState"] & unknown;
            /** @description 今日施工人数（null = 清空） */
            headcount?: number | null;
            doneWork?: string;
            /** @description 明日计划（null = 清空） */
            plan?: string | null;
            /** @description 现场发现问题（null = 清空；已生成问题不随清空撤回） */
            foundIssue?: string | null;
            /** @description 问题归类整体替换（多值；null / 空数组 = 清空 —— 「现场发现问题」非空时不可清空） */
            issueCategories?: components["schemas"]["IssueCategory"][] | null;
            suggestion?: string | null;
            /** @description 关联阶段整体替换（缺省 = 不改） */
            stageKeys?: components["schemas"]["StageKey"][];
            /** @description 现场工作附图整体替换（缺省 = 不改；空数组 = 清空） */
            photoFileIds?: components["schemas"]["Uuid"][];
            /** @description 当前问题附图整体替换（缺省 = 不改；空数组 = 清空）；该日报已生成问题时转挂目标 = 该问题 */
            issuePhotoFileIds?: components["schemas"]["Uuid"][];
            /** @description 内联问题清单整体替换（草稿 → 提交时逐条生成问题；空数组 = 清空；非空时与 foundIssue / issueCategories / suggestion / issuePhotoFileIds 互斥） */
            issues?: components["schemas"]["ReportIssueDraft"][];
        };
        /**
         * @description draft 暂存 / submitted 提交（缺省 submitted）
         * @default submitted
         * @enum {string}
         */
        DailyReportWriteState: "draft" | "submitted";
        /**
         * @description 角色数据范围：all > managed_projects > involved_projects > own_stakeholders > granted（多角色并集）
         * @enum {string}
         */
        DataScope: "all" | "managed_projects" | "involved_projects" | "own_stakeholders" | "granted";
        /**
         * Format: date
         * @description 项目**创建时间**下界（YYYY-MM-DD，含当日；按 Asia/Shanghai 取当日 00:00:00+08:00；Push 175 起维度 = projects.created_at）
         */
        DateOnly: string;
        /**
         * Format: date-time
         * @description ISO8601 时间戳（UTC 存储，前端按 Asia/Shanghai 展示）
         */
        DateTime: string;
        /** @description 单个字典（含元数据）；响应带 ETag，前端启动拉一次、登出清缓存 */
        Dict: {
            type: components["schemas"]["DictType"];
            items: components["schemas"]["DictItem"][];
            updatedAt: components["schemas"]["DateTime"];
        };
        DictItem: {
            /** @description 字典码（projects.region / projects.projectType 存该值） */
            code: string;
            /** @description 显示名 */
            name: string;
            /** @description 展示顺序（升序） */
            sort: number;
            /** @description 是否启用；**兼容字段**（Push 173 起产品口径：删除走 DELETE 物理删除，前端不再有停用入口；值恒为 true）—— 保留给二期「临时下架」与存量数据 */
            enabled: boolean;
            /** @description 引用该条目的**未删除项目**数（region → projects.region、projectType → projects.project_type；其余字典维度恒 0）；> 0 时删除返回 409 DICT_ITEM_IN_USE（A3 删除守卫，Push 174），前端据此把删除入口置灰 */
            usageCount: number;
            /** @description 字典元数据；projectType 必含 accent（CSS 颜色字符串，如 #3b82f6）；另有 accentText（徽标文字色，可缺省，缺省按 #fff 处理；浅色底如品牌黄 #feca04 用深灰 #313033）。前端据此渲染，不硬编码 */
            metadata: {
                [key: string]: unknown;
            };
        };
        /** @description 新增字典条目：region 任何登录用户可增（全站共享；重复码 409）；projectType 仅管理员 dict.manage；变更写审计留痕（C9-02）；响应为更新后的整个字典 */
        DictItemCreateBody: {
            /** @description 字典码：同类型内唯一；重复返回 409 DICT_ITEM_EXISTS */
            code: string;
            /** @description 显示名 */
            name: string;
            /**
             * @description 展示顺序（升序）；缺省 0
             * @default 0
             */
            sort: number;
            /**
             * @description 是否启用；缺省 true
             * @default true
             */
            enabled: boolean;
            /**
             * @description 字典元数据（projectType 必含 accent）
             * @default {}
             */
            metadata: {
                [key: string]: unknown;
            };
        };
        /** @description 更新字典条目（只传变更键）；本次变更写审计（含字段级 before / after，C9-02 / C7-02） */
        DictItemUpdateBody: {
            name?: string;
            sort?: number;
            /** @description 启用状态（兼容字段；一期删除走 DELETE 物理删除，前端不再调它） */
            enabled?: boolean;
            metadata?: {
                [key: string]: unknown;
            };
        };
        /** @description 全量字典（一期两个类型：region / projectType） */
        DictListResponse: {
            items: components["schemas"]["Dict"][];
        };
        /**
         * @description 字典类型（一期）：region 地区 / projectType 项目类型；未知类型返回 404
         * @enum {string}
         */
        DictType: "region" | "projectType";
        /**
         * @description 十类成果文件字典；门禁 required_doc 只能引用此字典（v0.2 §2.5）
         * @enum {string}
         */
        DocType: "CAD图纸" | "技术协议" | "合同" | "评审单" | "设备清单" | "物料总清单" | "发货装箱单" | "到货单" | "安装完成证明" | "验收单";
        /** @description 同内容哈希的既有文件提示（用户确认后可继续上传，不做强阻断） */
        DuplicateHint: {
            fileId: components["schemas"]["Uuid"];
            name: string;
            sizeBytes: number;
            uploadedBy: components["schemas"]["Uuid"];
            uploadedAt: components["schemas"]["DateTime"];
        } | null;
        /**
         * @description 统一错误码（技术设计v0.2 §7.2）
         * @enum {string}
         */
        ErrorCode: "VALIDATION_FAILED" | "AUTH_REQUIRED" | "AUTH_CALLBACK_FAILED" | "FORBIDDEN" | "NOT_FOUND" | "VERSION_CONFLICT" | "PROJECT_CODE_EXISTS" | "PROJECT_ARCHIVED" | "DICT_ITEM_EXISTS" | "DICT_ITEM_IN_USE" | "STAGE_GATE_NOT_PASSED" | "ARCHIVE_NOT_READY" | "ARCHIVE_GATE_NOT_PASSED" | "BLUEPRINT_NOT_PUBLISHED" | "NODE_REQUIRED_DOC_MISSING" | "TASK_REQUIRED_DOC_MISSING" | "NODE_HAS_FILES" | "STAGE_STATE_INVALID" | "NODE_ALREADY_DONE" | "NODE_ALREADY_EXISTS" | "NODE_DELETED" | "TASK_ALREADY_EXISTS" | "TASK_ALREADY_DONE" | "TASK_HAS_REFERENCES" | "TASK_FINALIZED" | "REPORT_ALREADY_EXISTS" | "BLUEPRINT_SCHEMA_INVALID" | "BLUEPRINT_REF_UNKNOWN" | "FILE_STATE_INVALID" | "UPLOAD_INCOMPLETE" | "UPLOAD_SESSION_EXPIRED" | "FILE_HASH_MISMATCH" | "IDEMPOTENT_REPLAY" | "PREVIEW_NOT_READY" | "PREVIEW_FAILED" | "IMPORT_FILE_INVALID" | "IMPORT_PARSE_FAILED" | "IMPORT_PREVIEW_EXPIRED" | "IMPORT_CANCELLED" | "RATE_LIMITED" | "INTERNAL";
        /** @description 字段级错误明细（校验失败、门禁缺件等） */
        ErrorDetail: {
            /** @example too_small */
            code: string;
            /** @example limit 必须是 1~200 的整数 */
            message: string;
            /** @example query.limit */
            path?: string;
            meta?: {
                [key: string]: unknown;
            };
        };
        /** @description 文件（v0.2 §5.2；定档后不可覆盖，修改必须走变更） */
        File: {
            id: components["schemas"]["Uuid"];
            projectId: components["schemas"]["Uuid"];
            nodeId: components["schemas"]["Uuid"] & (string | null);
            taskId: components["schemas"]["Uuid"] & (string | null);
            docType: components["schemas"]["DocType"] & (string | null);
            /**
             * @description 原文件名（含中文，保留在元数据）
             * @example 机械设计图纸-v2.docx
             */
            name: string;
            status: components["schemas"]["FileStatus"];
            currentVersionId: components["schemas"]["Uuid"] & (string | null);
            version: components["schemas"]["Version"];
            createdBy: components["schemas"]["Uuid"];
            createdAt: components["schemas"]["DateTime"];
            updatedAt: components["schemas"]["DateTime"];
            finalizedAt: components["schemas"]["DateTime"] & (string | null);
            finalizedBy: components["schemas"]["Uuid"] & (string | null);
            recycledAt: components["schemas"]["DateTime"] & (string | null);
            recycledBy: components["schemas"]["Uuid"] & (string | null);
            recycledFromStatus: components["schemas"]["FileStatus"] & (string | null);
        };
        /** @description 文件详情（含当前版本；版本链走 /files/{id}/versions） */
        FileDetail: components["schemas"]["File"] & {
            currentVersion: components["schemas"]["FileVersion"];
        };
        FileDownloadUrlResponse: {
            /** @description 短时签名下载地址（写查看 / 下载审计；对象存储禁止匿名读取） */
            url: string;
            fileName: string;
            sizeBytes: number;
            expiresAt: components["schemas"]["DateTime"];
        };
        /** @description 定档（锁版）：至少存在 1 个版本；定档后不可覆盖或替换；**挂接任务的文件定档时，同事务把该任务一并定档**（Push 249：任务定档后不支持任何修改，见 Task.finalizedAt / 409 TASK_FINALIZED） */
        FileFinalizeBody: {
            version: components["schemas"]["Version"];
        };
        FileListResponse: {
            items: components["schemas"]["File"][];
            page: number;
            limit: number;
            total: number;
        };
        /** @description 图片附件引用（多态关联读面；不做匿名直链，预览经预览接口换短时签名） */
        FilePhotoRef: {
            fileId: components["schemas"]["Uuid"];
            /** @description 原文件名（缩略图角标 / 无障碍文案） */
            name: string;
        };
        /** @description 文件预览状态与短时签名地址 / 查看器配置（异步产物；未就绪 / 失败为 200 语义 —— not_ready 时服务端幂等补投生成任务，前端轮询至 ready / failed；ONLYOFFICE 查看器通道（S1 契约 / S3 起签发）：ready + viewer 非空、url 为空） */
        FilePreviewResponse: {
            fileId: components["schemas"]["Uuid"];
            versionId: components["schemas"]["Uuid"] & (string | null);
            status: components["schemas"]["PreviewStatus"];
            target: components["schemas"]["PreviewTarget"];
            viewer: components["schemas"]["PreviewViewer"];
            /** @description 短时签名预览地址（仅 ready；未就绪 / 失败为空；对象存储禁止匿名读取） */
            url: string | null;
            expiresAt: components["schemas"]["DateTime"] & (string | null);
            /** @description 产物对应的转换管线版本（服务端配置下发，如 PREVIEW_PIPELINE_VERSION；客户端不解析，用于缓存失效 / 排障）；未生成过为空 */
            pipelineVersion: string | null;
            /** @description 失败原因（仅 failed，最长 500 字；D2-05 记录原因，不影响下载） */
            reason: string | null;
            generatedAt: components["schemas"]["DateTime"] & (string | null);
        };
        /** @description 彻底删除（仅管理员；对象与元数据一并清理，操作留痕） */
        FilePurgeBody: {
            version: components["schemas"]["Version"];
            reason?: string;
        };
        FilePurgeResponse: {
            fileId: components["schemas"]["Uuid"];
            purgedAt: components["schemas"]["DateTime"];
        };
        /** @description 移入回收站（任意状态可删；默认保留 30 天，可恢复） */
        FileRecycleBody: {
            version: components["schemas"]["Version"];
            reason?: string;
        };
        /** @description 文件改名（Push 226 续：文件名可修改；乐观锁 version 必传；回收站中的文件不可改名） */
        FileRenameBody: {
            /**
             * @description 新文件名（原文件名的元数据改名：不动内容 / 版本链 / 定档状态）
             * @example 机械设计图纸-v3.docx
             */
            name: string;
            version: components["schemas"]["Version"];
        };
        FileRestoreBody: {
            version: components["schemas"]["Version"];
        };
        /** @description 回溯生成新版本（不删除历史版本；定档后回溯走变更、申请即通过） */
        FileRollbackBody: {
            toVersionId: components["schemas"]["Uuid"] & unknown;
            /** @description 回溯原因（留痕；定档 / 已变更文件按变更流处理） */
            reason: string;
            version: components["schemas"]["Version"];
        };
        FileRollbackResponse: {
            file: components["schemas"]["File"];
            version: components["schemas"]["FileVersion"];
            changeRequest: components["schemas"]["ChangeRequest"] & unknown;
        };
        /**
         * @description 文件五态（v0.2 §5.2）
         * @enum {string}
         */
        FileStatus: "draft" | "final" | "changed" | "archived" | "recycled";
        /** @description 文件版本（v0.2 §5.1；对象键 = projects/{projectId}/files/{fileId}/v{seq}/{contentHash}.{ext}） */
        FileVersion: {
            id: components["schemas"]["Uuid"];
            fileId: components["schemas"]["Uuid"];
            /** @description 版本号（同一文件内递增，从 1 开始） */
            seq: number;
            sizeBytes: number;
            contentHash: components["schemas"]["Sha256"] & unknown;
            mime: string | null;
            uploadedBy: components["schemas"]["Uuid"];
            uploadedAt: components["schemas"]["DateTime"];
            changeRequestId: components["schemas"]["Uuid"] & (string | null);
        } | null;
        FileVersionListResponse: {
            items: components["schemas"]["FileVersion"][];
            total: number;
        };
        /** @description 批量关注 / 取关（A1-15；部分失败不影响其它条目） */
        FollowBatchBody: {
            /** @description 批量条目（1 ~ 50；逐条独立处理） */
            items: {
                objectType: components["schemas"]["FollowObjectType"];
                objectId: components["schemas"]["Uuid"];
                /** @description true 关注 / false 取消 */
                follow: boolean;
            }[];
        };
        /**
         * @description 批量失败原因：not_found 目标不存在 / 不可见 / 已删除（仅关注动作产生；取关不存在的行 = unchanged）
         * @enum {string}
         */
        FollowBatchFailureCode: "not_found";
        /** @description 批量结果（整体 200；失败清单给逐条原因） */
        FollowBatchResponse: {
            /** @description 新关注数 */
            followed: number;
            /** @description 取消关注数 */
            unfollowed: number;
            /** @description 无需变更数（重复关注 / 取关不存在的行） */
            unchanged: number;
            /** @description 失败项（顺序 = 请求顺序） */
            failures: {
                /** @description 条目在请求里的下标（0 起） */
                index: number;
                objectType: components["schemas"]["FollowObjectType"];
                objectId: components["schemas"]["Uuid"];
                code: components["schemas"]["FollowBatchFailureCode"];
                message: string;
            }[];
        };
        /** @description 关注（目标必须可见且未删除；重复关注幂等） */
        FollowCreateBody: {
            objectType: components["schemas"]["FollowObjectType"];
            objectId: components["schemas"]["Uuid"];
        };
        /** @description 关注结果（幂等） */
        FollowCreateResponse: {
            item: components["schemas"]["FollowItem"];
            /** @description true = 本次新建（201）；false = 已关注（幂等，200） */
            created: boolean;
        };
        /** @description 取关结果 */
        FollowDeleteResponse: {
            objectType: components["schemas"]["FollowObjectType"];
            objectId: components["schemas"]["Uuid"];
            /** @description 恒为 true（未关注 = 404，不返回本响应） */
            removed: boolean;
        };
        /** @description 关注关系（我的关注清单行；随行名称用于列表展示） */
        FollowItem: {
            objectType: components["schemas"]["FollowObjectType"];
            objectId: components["schemas"]["Uuid"] & unknown;
            projectId: components["schemas"]["Uuid"] & unknown;
            /** @description 项目编号（随行展示） */
            projectCode: string;
            /** @description 关注对象名称（项目名 / 任务标题；随行展示） */
            name: string;
            createdAt: components["schemas"]["DateTime"] & unknown;
        };
        /** @description 关注清单（当前会话用户） */
        FollowListResponse: {
            /** @description 我的关注清单（createdAt 降序 → id 升序；不可见 / 已删对象不返回） */
            items: components["schemas"]["FollowItem"][];
        };
        /**
         * @description 关注对象类型：project 项目 / task 任务
         * @enum {string}
         */
        FollowObjectType: "project" | "task";
        /** @description 仪表盘页的常驻项目 id（Push 336 · 按账号记住；Push 358 起六个图表视图共用）：null = 全部项目（默认）；项目已不存在时界面回落全部项目，读侧非字符串 / 空串 / 超长一律收敛为 null */
        HubDashProject: string | null;
        /**
         * @description 仪表盘页内图表视图（Push 345 · 业务口径 2026-10-16「选择后刷新不变 按账号记住」；Push 353 加「词频图」、Push 358 加「数据总览」）：overview = 「数据总览」/ progress = 「项目进度」（默认）/ status = 「任务状态」/ issues = 「问题」/ delivery = 「交付时间」/ wordcloud = 「词频图」；刷新 / 换设备同账号保持，读侧白名单外 / 缺省一律收敛为 progress
         * @enum {string}
         */
        HubDashView: "overview" | "progress" | "status" | "issues" | "delivery" | "wordcloud";
        /**
         * @description 仪表盘页（`#/`）的常驻视图（Push 332 · 按账号记住）：map = 世界地图（默认）/ dashboard = 仪表盘大屏（含数据总览 / 项目进度 等六个图表视图）；地址显式带 `?view=dashboard` 时以地址为准，读侧白名单外 / 缺省一律收敛为 map
         * @enum {string}
         */
        HubView: "map" | "dashboard";
        /** @description 写操作幂等键（Idempotency-Key 请求头）；重复提交返回首次结果 */
        IdempotencyKey: string;
        /** @description 一条问题记录（由日报自动生成或手工创建） */
        Issue: {
            id: components["schemas"]["Uuid"];
            projectId: components["schemas"]["Uuid"];
            taskId: components["schemas"]["Uuid"] & (string | null);
            sourceReportId: components["schemas"]["Uuid"] & (string | null);
            /** @description 问题描述（自动生成 = 日报「现场发现问题」原文；超 500 字截短落库） */
            title: string;
            categories: components["schemas"]["IssueCategoryList"] & unknown;
            state: components["schemas"]["IssueState"];
            reporterId: components["schemas"]["Uuid"];
            /** @description 提出人显示名（= 来源日报提交人） */
            reporterName: string | null;
            /** @description 责任部门（A3-12 按归类自动分派；未分派 = null） */
            ownerDepartment: string | null;
            ownerId: components["schemas"]["Uuid"] & (string | null);
            ownerName: string | null;
            raisedAt: components["schemas"]["DateOnly"] & unknown;
            /** @description 解决方案 / 回复（A3-13） */
            solution: string | null;
            /** @description 问题附图（file_links(object_type=issue)）：来源 = 日报问题图提交转入，可在问题侧独立增删 */
            photos: components["schemas"]["FilePhotoRef"][];
            closedBy: components["schemas"]["Uuid"] & (string | null);
            closedAt: components["schemas"]["DateTime"] & (string | null);
            createdAt: components["schemas"]["DateTime"];
            updatedAt: components["schemas"]["DateTime"];
            version: components["schemas"]["Version"];
        };
        /**
         * @description 问题归类（A3-11 · C9 字典十项）；一期为契约固定枚举，字典可维护随后
         * @enum {string}
         */
        IssueCategory: "机械部" | "采购部" | "规划部" | "项目部" | "物流原因" | "供应商原因" | "客户原因" | "客观原因" | "生产原因" | "其它原因";
        /** @description 问题归类（多值 ≥1 项；C9 十项） */
        IssueCategoryList: components["schemas"]["IssueCategory"][];
        /** @description 问题删除（成对删除来源日报） */
        IssueDeleteResponse: {
            id: components["schemas"]["Uuid"];
            /** @enum {boolean} */
            deleted: true;
            cascadedReportId: components["schemas"]["Uuid"] & (string | null);
            /** @description 连带删除的其它问题（删问题 = 连它来源日报派生的其它问题；不含自身） */
            cascadedIssueIds: components["schemas"]["Uuid"][];
        };
        /** @description 问题详情 = 问题 + 处理过程留痕 */
        IssueDetail: components["schemas"]["Issue"] & {
            /** @description 处理过程留痕（时间正序） */
            events: components["schemas"]["IssueEvent"][];
        };
        /** @description 问题处理过程留痕（A3-13：创建 / 状态流转 / 解决方案 / 分派） */
        IssueEvent: {
            id: components["schemas"]["Uuid"];
            issueId: components["schemas"]["Uuid"];
            eventType: components["schemas"]["IssueEventType"];
            fromState: components["schemas"]["IssueState"] & (string | null);
            toState: components["schemas"]["IssueState"] & (string | null);
            actorId: components["schemas"]["Uuid"];
            actorName: string | null;
            note: string | null;
            createdAt: components["schemas"]["DateTime"];
        };
        /**
         * @description 问题事件类型（A3-13）：created 创建 / state_change 状态流转 / solution 解决方案 / assignment 分派
         * @enum {string}
         */
        IssueEventType: "created" | "state_change" | "solution" | "assignment";
        /** @description 问题列表（问题追踪表 / 问题看板共用；看板按三态分组由前端渲染） */
        IssueListResponse: {
            items: components["schemas"]["Issue"][];
            page: number;
            limit: number;
            total: number;
        };
        /**
         * @description 问题三态（A3-10）：open 未解决 / in_progress 处理中 / done 已完成；允许回退且留痕
         * @enum {string}
         */
        IssueState: "open" | "in_progress" | "done";
        /** @description 问题更新（状态流转 / 描述 / 归类 / 解决方案 / 分派 / 附图；前五类变化写一条事件） */
        IssueUpdateBody: {
            version: components["schemas"]["Version"];
            state?: components["schemas"]["IssueState"] & unknown;
            /** @description 问题描述（行内编辑 / 抽屉编辑，Push 208 / 212） */
            title?: string;
            categories?: components["schemas"]["IssueCategoryList"] & unknown;
            /** @description 解决方案 / 回复（null = 清空） */
            solution?: string | null;
            /** @description 责任部门（null = 取消分派部门） */
            ownerDepartment?: string | null;
            /**
             * Format: uuid
             * @description 责任人（null = 取消责任人）
             */
            ownerId?: string | null;
            /** @description 本次处理的备注（A3-13 留痕） */
            note?: string;
            /** @description 问题附图整体替换（file_links(object_type=issue)；缺省 = 不改；空数组 = 清空） */
            photoFileIds?: components["schemas"]["Uuid"][];
        };
        /**
         * @description 界面语言（Push 296 · 顶栏「语言 · 中文 / English」）：zh = 中文（默认）/ en = English；读侧白名单外 / 缺省一律收敛为 zh
         * @enum {string}
         */
        Locale: "zh" | "en";
        /** @description /auth/me 响应（会话由 HttpOnly Cookie 承载） */
        MeResponse: {
            user: components["schemas"]["User"];
            /** @description ID Token 声明（已验签；排障用） */
            claims: {
                [key: string]: unknown;
            };
            /**
             * @description ID Token 到期时间（Unix 秒，UTC）；null = 未知
             * @example 1758182400
             */
            expiresAt: number | null;
        };
        /** @description 「我的计划」便签墙（Push 268）：按账号跨设备可见；读侧坏形状逐条收敛 */
        MyPlanBoard: components["schemas"]["MyPlanBoardUpdate"] & {
            bg: components["schemas"]["PlanBoardBg"];
            updatedAt: components["schemas"]["DateTime"] & (string | null);
        };
        /** @description 「我的计划」便签墙 PATCH 体（客户端只传 notes / categories / bg；updatedAt 由服务端盖章） */
        MyPlanBoardUpdate: {
            /** @description 便签列表（整体替换语义；≤ 300 条） */
            notes: components["schemas"]["MyPlanNote"][];
            /** @description 分类表（整体替换语义；≤ 12 类） */
            categories: string[];
            bg?: components["schemas"]["PlanBoardBg"] & unknown;
        };
        /** @description 「我的计划」单条便签（Push 268） */
        MyPlanNote: {
            /** @description 便签 id（前端生成 pn- 前缀；跨设备同步后保持不变） */
            id: string;
            /** @description 标题（≤ 40 字；与内容可各自为空，但不同时为空） */
            title: string;
            /** @description 内容（≤ 2000 字） */
            content: string;
            /** @description 分类名（≤ 10 字；引用 categories 表） */
            category: string;
            colorId: components["schemas"]["PlanBoardColor"];
            fontId: components["schemas"]["PlanBoardFont"];
            /** @description 完成态（Push 268）：true = 收进「已完成」，便签墙（含分类视图）不再显示 */
            done: boolean;
            createdAt: components["schemas"]["DateTime"] & unknown;
            updatedAt: components["schemas"]["DateTime"] & unknown;
        };
        NodeCompleteBody: {
            version: components["schemas"]["Version"];
        };
        NodeCompleteResponse: {
            node: components["schemas"]["ProjectNode"];
        };
        /** @description 新增节点（仅模板节点池，留痕） */
        NodeCreateBody: {
            stageId: components["schemas"]["Uuid"];
            /** @description 模板节点池内的节点稳定键（一期仅允许项目导入版本的蓝图 key） */
            nodeKey: string;
            name?: string;
            seq?: number;
            /** @description 增补原因（留痕；ADR-020） */
            reason?: string;
        };
        NodeDeleteBody: {
            version: components["schemas"]["Version"];
            /** @description 删除原因（必填并留痕；ADR-020） */
            reason: string;
        };
        /** @description 缺件明细（门禁拒绝时会一次性返回） */
        NodeGateMissing: {
            docType: components["schemas"]["DocType"];
            required: number;
            present: number;
        };
        /**
         * @description 节点来源；一期增删仅限模板节点池
         * @enum {string}
         */
        NodeOrigin: "blueprint" | "added_by_user";
        /** @description 节点约束实例（node_requirements） */
        NodeRequirement: {
            /** @enum {string} */
            requirementType: "required_doc" | "field" | "dependency" | "deadline";
            docType: components["schemas"]["DocType"] & (string | null);
            minCount: number;
        };
        /**
         * @description 节点状态（project_nodes.status）；done 必须过门禁
         * @enum {string}
         */
        NodeStatus: "pending" | "active" | "done" | "deleted";
        /** @description 收件箱条目（已投递；合并子行不进收件箱、只在库内留档） */
        Notification: {
            /** @description 通知 id（库内自增；收件箱以 id 降序） */
            id: number;
            type: components["schemas"]["NotificationType"];
            /** @description 标题（已剔除前后空白） */
            title: string;
            /** @description 正文（已剔除前后空白；首条消息的正文，被合并行正文留档在库内） */
            body: string;
            status: components["schemas"]["NotificationStatus"];
            /** @description 关联对象类型（可空） */
            refType: string | null;
            refId: components["schemas"]["Uuid"] & (string | null);
            /** @description 模板码（可空） */
            templateCode: string | null;
            /** @description 合并条数：同期同合并键的消息条数（未合并 = 1） */
            mergedCount: number;
            snoozeUntil: components["schemas"]["DateTime"] & (string | null);
            deliveredAt: components["schemas"]["DateTime"] & unknown;
            createdAt: components["schemas"]["DateTime"] & unknown;
        };
        /** @description 收件箱清单（含未读角标计数） */
        NotificationListResponse: {
            items: components["schemas"]["Notification"][];
            page: number;
            limit: number;
            /** @description 当前筛选下的总条数 */
            total: number;
            /** @description 未读总数（不受 status 过滤影响；角标口径） */
            unreadCount: number;
        };
        /** @description 全部标记已读结果 */
        NotificationMarkAllReadResponse: {
            /** @description 本次实际置为已读的条数 */
            updated: number;
            /** @description 置位后的未读数（恒为 0；回读口径） */
            unreadCount: number;
        };
        /** @description 标记收件箱状态（幂等；已处理可退回已读） */
        NotificationMarkBody: {
            status: components["schemas"]["NotificationStatus"];
        };
        /** @description 设置稍后提醒（重复设置 = 覆盖旧记录 + 新记录） */
        NotificationSnoozeBody: {
            snoozeUntil: components["schemas"]["DateTime"] & unknown;
        };
        /** @description 稍后提醒记录清单（按 id 降序，不翻页） */
        NotificationSnoozeListResponse: {
            items: components["schemas"]["NotificationSnoozeRecord"][];
        };
        /** @description 稍后提醒记录（C5-05「设置与触发记录可查」；一次设置一条，触发 / 取消回填对应时刻） */
        NotificationSnoozeRecord: {
            /** @description 记录 id（自增；读面按 id 降序） */
            id: number;
            setAt: components["schemas"]["DateTime"] & unknown;
            snoozeUntil: components["schemas"]["DateTime"] & unknown;
            triggeredAt: components["schemas"]["DateTime"] & (string | null);
            cancelledAt: components["schemas"]["DateTime"] & (string | null);
        };
        /**
         * @description 收件箱状态：unread 未读 / read 已读 / handled 已处理（标记接口幂等；允许回退到更早状态）
         * @enum {string}
         */
        NotificationStatus: "unread" | "read" | "handled";
        /**
         * @description 通知类型（C5-02 分类）：reminder 提醒（任务 / 日报 / 问题等业务提醒）/ approval 审批（待办审批与门禁）/ broadcast 播报（喜报 / 阶段达成 / 摘要群发同步留档）/ system 系统（账号 / 权限 / 运维通知）
         * @enum {string}
         */
        NotificationType: "reminder" | "approval" | "broadcast" | "system";
        /** @description 通知偏好（免打扰时段 / 每日上限 / 合并窗口；读面为生效值） */
        NotifyPrefs: {
            quietHours: components["schemas"]["NotifyQuietHours"];
            /** @description 免打扰开始（生效值，HH:MM，Asia/Shanghai）；null = 免打扰关闭 */
            quietFrom: string | null;
            /** @description 免打扰结束（生效值，HH:MM，Asia/Shanghai）；跨零点允许（from > to）；null = 免打扰关闭 */
            quietTo: string | null;
            /** @description 每人每日投递上限（0 = 不限）；超限消息排到次日窗口起点 */
            dailyLimit: number;
            /** @description 合并窗口（毫秒；0 = 不合并）：同人同合并键、窗口内未读主行合并为一条 */
            mergeWindowMs: number;
            updatedAt: components["schemas"]["DateTime"] & (string | null);
        };
        /** @description 通知偏好更新（局部更新：只传变更键；quietHours 三态 default / off / HH:MM-HH:MM；空更新 400） */
        NotifyPrefsUpdateBody: {
            quietHours?: components["schemas"]["NotifyQuietHours"];
            dailyLimit?: number;
            mergeWindowMs?: number;
        };
        /** @description 免打扰配置（三态）：default 继承缺省（env NOTIFY_QUIET_HOURS，缺省 22:00-08:00）/ off 关闭 / HH:MM-HH:MM 自定义（Asia/Shanghai，跨零点允许） */
        NotifyQuietHours: string;
        /**
         * @description 功能权限位（模块.操作）；一期取值见 PERMISSION_KEYS（种子 #6b 按角色分配）
         * @enum {string}
         */
        PermissionKey: "project.view" | "project.create" | "project.update" | "project.delete" | "project.archive" | "project.export" | "member.view" | "member.manage" | "task.view" | "task.create" | "task.update" | "task.progress" | "report.view" | "report.fill" | "issue.view" | "issue.manage" | "node.view" | "node.create" | "node.delete" | "node.complete" | "node.advance" | "node.rollback" | "blueprint.view" | "blueprint.manage" | "file.upload" | "file.download" | "stakeholder.view" | "stakeholder.manage" | "stakeholder.contact.view" | "dict.manage" | "audit.view" | "calendar.manage";
        /** @description 当前用户授权画像（未登录 401） */
        PermissionMeResponse: {
            permissions: components["schemas"]["ActorPermissions"];
        };
        /**
         * @description 背景色（Push 271）：读侧白名单外 / 缺省一律收敛为 white（与前端 myPlan.ts 同口径）
         * @enum {string}
         */
        PlanBoardBg: "white" | "cream" | "pink" | "orange" | "yellow" | "lime" | "emerald" | "sky" | "blue" | "violet" | "lavender";
        /**
         * @description 便签颜色 id（7 色 hex 调色板，与前端 myPlan.ts 同源）
         * @enum {string}
         */
        PlanBoardColor: "white" | "yellow" | "green" | "blue" | "purple" | "pink" | "orange";
        /**
         * @description 便签字体 id（简约 / 优雅 / 等宽，与前端 myPlan.ts 同源）
         * @enum {string}
         */
        PlanBoardFont: "sans" | "serif" | "mono";
        /**
         * @description 预览状态：ready 产物就绪（附短时签名 URL） / not_ready 尚未生成（服务端幂等补投生成任务、按三元组去重，前端轮询至 ready / failed —— 不引入请求约定） / failed 转换失败（记原因并降级「请下载」）
         * @enum {string}
         */
        PreviewStatus: "ready" | "not_ready" | "failed";
        /**
         * @description 已就绪转换产物的目标（渲染通道）；查看器通道 / 未就绪 / 失败为空 —— 查看器就绪以 viewer 判定
         * @enum {string|null}
         */
        PreviewTarget: "pdf" | "image" | "structured" | null;
        /** @description 在线查看器配置（仅 ready 且走查看器通道时非空；与 url 互斥 —— 查看器通道无转换产物；S3 起签发） */
        PreviewViewer: {
            kind: components["schemas"]["PreviewViewerKind"];
            /** @description DocServer 基址（前端据此加载 /web-apps/apps/api/documents/api.js 初始化 DocEditor；服务端配置下发） */
            docServerUrl: string;
            documentType: components["schemas"]["PreviewViewerDocumentType"];
            document: components["schemas"]["PreviewViewerDocument"];
            editorConfig: components["schemas"]["PreviewViewerEditorConfig"];
            /** @description 查看器 JWT（HS256；载荷 = documentType / document（含 permissions）/ editorConfig 逐字签发 + iat / exp；浏览器持有 —— 泄漏面仅只读会话，取原文件依赖服务端端点鉴权） */
            token: string;
        } | null;
        PreviewViewerDocument: {
            /** @description 文档标题（展示用；取文件名） */
            title: string;
            /** @description 受控预览内容端点绝对 URL（DocServer 视角；无存储凭证；浏览器直取 401、外网入口 404） */
            url: string;
            /** @description 文件类型（扩展名小写，如 docx / xlsx / pptx） */
            fileType: string;
            /** @description 文档 key（内容哈希派生：同内容同 key —— DocServer 侧会话与缓存复用；S3 起生效） */
            key: string;
            permissions: components["schemas"]["PreviewViewerPermissions"];
        };
        /**
         * @description 文档大类（word 文档 / cell 表格 / slide 演示 / pdf 文档；由文件类型映射）
         * @enum {string}
         */
        PreviewViewerDocumentType: "word" | "cell" | "slide" | "pdf";
        PreviewViewerEditorConfig: {
            /**
             * @description 固定 view（只读；与 permissions 行为面 + 服务端受控端点双重约束）
             * @enum {string}
             */
            mode: "view";
            /** @description 界面语言（如 zh-CN） */
            lang: string;
            /** @description 会话标识（展示用；查看会话不落用户审计 —— 审计在签发查看器配置时点） */
            user: {
                id: string;
                name: string;
            };
        };
        /**
         * @description 在线查看器类型（一期仅 onlyoffice —— ONLYOFFICE 文档服务器查看器；后续查看器扩展在此枚举追加）
         * @enum {string}
         */
        PreviewViewerKind: "onlyoffice";
        /** @description 查看器权限段（Push 258 起嵌 document —— ONLYOFFICE 只认该位置；download 保持可见、点击由前端命中层接管 → 原文件下载链） */
        PreviewViewerPermissions: {
            edit: boolean;
            download: boolean;
            print: boolean;
            comment: boolean;
            chat: boolean;
            fillForms: boolean;
            protect: boolean;
        };
        /**
         * @description 紧急重要度三档字典（高 / 中 / 低）；2026-09-24 定案「与页面口径一致」—— 四象限口径作废，存量值由迁移 0031 折算（有损：中 = 重要不紧急 / 紧急但不重要）
         * @enum {string|null}
         */
        Priority: "高" | "中" | "低" | null;
        /** @description 项目（v0.2 §2.3 projects） */
        Project: {
            id: components["schemas"]["Uuid"];
            /**
             * @description 项目编号：创建人填写（建后可修改）；服务端只校验唯一性，不生成；格式仅前端提示
             * @example CNBJ-20260708-0001
             */
            code: string;
            /**
             * @description 项目序号：服务端创建时分配（全库唯一、不可修改、不回收；与项目编号一一对应同一项目）；卡片等展示场景两位补零，列表支持 sort=seqNo:asc|desc
             * @example 1
             */
            seqNo: number;
            /** @example XX 客户分拣项目 */
            name: string;
            customer: string | null;
            /** @description 项目落地地区（字典 region；缺省「未分类」） */
            region: string;
            /** @description 项目类型（字典 project_type；主题色随字典元数据下发，前端不硬编码） */
            projectType: string;
            /** @description 项目经理（A22 · Push 136：一位也可、可多位）：至少一位、数组顺序 = 展示顺序（前端按「、」连接展示）；与 managerNames 同下标一一对应 */
            managerIds: components["schemas"]["Uuid"][];
            /** @description 项目经理姓名数组：服务端按 managerIds 解析后随行下发，与 managerIds 同下标一一对应（列表 / 详情 / 创建与编辑返回均含，免前端二次查目录）；人员停用 / 离职后仍返回姓名，取不到时该位为 null（前端显示「—」） */
            managerNames: (string | null)[];
            stageKey: components["schemas"]["StageKey"];
            status: components["schemas"]["ProjectStatus"];
            description: string | null;
            version: components["schemas"]["Version"];
            createdAt: components["schemas"]["DateTime"];
            updatedAt: components["schemas"]["DateTime"];
            archivedAt: components["schemas"]["DateTime"] & (string | null);
            archivedBy: components["schemas"]["Uuid"] & (string | null);
        };
        /** @description 归档请求：version 必带；缺项越过分两步（先 422 拿清单，再 confirm=true 重试） */
        ProjectArchiveBody: {
            version: components["schemas"]["Version"] & unknown;
            /**
             * @description 缺项确认：false（缺省）= 有缺项即 422；true = 确认带缺项归档（缺项入清单 acknowledgedMissing）
             * @default false
             */
            confirm: boolean;
        };
        /** @description 归档缺项条目（确认越过时原样入清单 acknowledgedMissing） */
        ProjectArchiveMissing: {
            /**
             * @description 缺项类型：task_not_done 未完成任务 / file_not_final 未定档文件 / doc_missing 必交成果缺件（A4-20 口径）
             * @enum {string}
             */
            code: "task_not_done" | "file_not_final" | "doc_missing";
            message: string;
            /** @description 缺项定位（任务 id / 文件 id / 节点与文档类型等） */
            meta: {
                [key: string]: unknown;
            };
        };
        /** @description 归档清单（引用式快照：统计口径 + 文件清单含版本 + 变更 / 日报 / 问题；只记 id 与摘要） */
        ProjectArchiveSnapshot: {
            stage: {
                stageKey: components["schemas"]["StageKey"];
                /** @description 阶段状态（归档时点；验收阶段应为 done） */
                status: string;
                advancedAt: components["schemas"]["DateTime"] & (string | null);
            };
            tasks: {
                total: number;
                byStatus: {
                    pending: number;
                    active: number;
                    done: number;
                };
            };
            files: {
                total: number;
                items: {
                    id: components["schemas"]["Uuid"];
                    name: string;
                    /** @description 文档类型（字典 docType；未归类 = null） */
                    docType: string | null;
                    /** @description 文件状态（draft / final / changed / archived / recycled 原样记） */
                    status: string;
                    nodeId: components["schemas"]["Uuid"] & (string | null);
                    /** @description 版本数（含历史版本） */
                    versionCount: number;
                    /** @description 最新版本序号（无版本 = null） */
                    latestSeq: number | null;
                    latestUploadedAt: components["schemas"]["DateTime"] & (string | null);
                }[];
            };
            changes: {
                total: number;
                items: {
                    id: components["schemas"]["Uuid"];
                    /** @description 变更原因（摘要） */
                    reason: string;
                    stageKey: components["schemas"]["StageKey"] & (string | null);
                    appliedAt: components["schemas"]["DateTime"];
                }[];
            };
            reports: {
                total: number;
                byState: {
                    draft: number;
                    submitted: number;
                    supplement: number;
                };
            };
            issues: {
                total: number;
                byState: {
                    open: number;
                    in_progress: number;
                    done: number;
                };
            };
        };
        /** @description 归档记录与清单（POST 归档返回；GET /projects/{id}/archive 读面同形） */
        ProjectArchiveView: {
            id: components["schemas"]["Uuid"];
            projectId: components["schemas"]["Uuid"];
            archivedAt: components["schemas"]["DateTime"];
            archivedBy: components["schemas"]["Uuid"];
            /** @description 归档操作人姓名（users.display_name；取不到 = null） */
            archivedByName: string | null;
            snapshot: components["schemas"]["ProjectArchiveSnapshot"];
            /** @description 确认越过的缺项清单（无缺项 = 空数组） */
            acknowledgedMissing: components["schemas"]["ProjectArchiveMissing"][];
        };
        /** @description 创建项目：项目序号 seqNo 不接受传入，由服务端分配并随响应返回 */
        ProjectCreateBody: {
            /**
             * @description 项目编号：创建人填写；格式仅前端提示，服务端不做强校验；重复返回 409 PROJECT_CODE_EXISTS
             * @example CNBJ-20260708-0001
             */
            code: string;
            name: string;
            customer?: string;
            /**
             * @description 项目落地地区（字典 region）；未填写归入「未分类」（A1-12 定档）
             * @default 未分类
             */
            region: string;
            /**
             * @description 项目类型（字典 project_type）；未填写归入「未分类」（A1-12 定档）
             * @default 未分类
             */
            projectType: string;
            /** @description 项目经理（A22 · Push 136）：至少一位、可多位；数组顺序 = 展示顺序；判空失败返回 400 VALIDATION_FAILED */
            managerIds: components["schemas"]["Uuid"][];
            stageKey?: components["schemas"]["StageKey"];
            description?: string;
            /** @description 导入的蓝图版本；缺省 = 当前已发布版本 */
            blueprintVersion?: number;
        };
        /** @description 首页分类计数；计数与列表同口径（同筛选条件）；五组固定返回，前端按需展示（A6） */
        ProjectFacets: {
            total: number;
            region: {
                [key: string]: number;
            };
            projectType: {
                [key: string]: number;
            };
            /** @description 项目经理维度计数：键 = users.id；一个项目挂多位经理时**每位各计一次**（A22 · Push 136） */
            managerId: {
                [key: string]: number;
            };
            stageKey: {
                [key: string]: number;
            };
            status: {
                [key: string]: number;
            };
        };
        /** @description 项目流程（阶段 + 节点 + 约束 + 状态）；导入即快照 */
        ProjectFlow: {
            projectId: components["schemas"]["Uuid"];
            /** @description 项目导入时的蓝图版本（快照）；0 = 尚未导入（h3 之前建的项目） */
            blueprintVersion: number;
            stages: components["schemas"]["ProjectStage"][];
        };
        /** @description 项目群绑定状态（GET 恒 200；未绑定 = bound:false） */
        ProjectGroupBinding: {
            projectId: components["schemas"]["Uuid"];
            /** @description 是否已绑定（false = 未绑定，其余字段为 null / false） */
            bound: boolean;
            /** @description 群名 / 备注（绑定维护用）；未绑定 = null */
            name: string | null;
            /** @description 绑定 chatid 掩码（只回末 4 位）；未绑定 = null */
            chatidMasked: string | null;
            /** @description 会话已激活（群内有人给机器人发过消息）；未绑定 = false */
            activated: boolean;
            updatedAt: components["schemas"]["DateTime"] & (string | null);
        };
        /** @description 绑定 / 换绑项目群：chatid 必填 + 群名备注可空；PUT = upsert 覆盖语义 */
        ProjectGroupPutBody: {
            /** @description 企微会话 id（群消息回调 body.chatid 自动落库；形如 34 位 base64url 串） */
            chatid: string;
            /** @description 群名 / 备注（维护用；可空 —— 覆盖语义下缺省 = 清空） */
            name?: string | null;
        };
        ProjectListResponse: {
            items: components["schemas"]["Project"][];
            page: number;
            limit: number;
            total: number;
        };
        /** @description 项目成员（名册行） */
        ProjectMember: {
            userId: components["schemas"]["Uuid"];
            /**
             * @description 工号（users.username）
             * @example 10086
             */
            username: string;
            /** @description 姓名（users.display_name；账号停用 / 离职后仍返回） */
            displayName: string;
            roleInProject: components["schemas"]["ProjectMemberRole"];
            joinedAt: components["schemas"]["DateTime"] & unknown;
        };
        /** @description 添加成员：重复添加（同 project + user）幂等并覆盖角色；项目归档后拒绝（409 PROJECT_ARCHIVED） */
        ProjectMemberCreateBody: {
            userId: components["schemas"]["Uuid"];
            roleInProject?: components["schemas"]["ProjectMemberRole"] & unknown;
        };
        ProjectMemberListResponse: {
            items: components["schemas"]["ProjectMember"][];
            total: number;
        };
        /**
         * @description 项目内角色：project_manager（项目经理）/ project_member（项目成员）；只作用于项目名册，不改变全局功能权限
         * @enum {string}
         */
        ProjectMemberRole: "project_manager" | "project_member";
        ProjectNode: {
            id: components["schemas"]["Uuid"];
            projectId: components["schemas"]["Uuid"];
            stageId: components["schemas"]["Uuid"];
            nodeKey: string;
            name: string;
            seq: number;
            status: components["schemas"]["NodeStatus"];
            origin: components["schemas"]["NodeOrigin"];
            doneAt: components["schemas"]["DateTime"] & (string | null);
            doneBy: components["schemas"]["Uuid"] & (string | null);
            sourceBlueprintVersion: number;
            version: components["schemas"]["Version"];
            requirements: components["schemas"]["NodeRequirement"][];
        };
        ProjectStage: {
            id: components["schemas"]["Uuid"];
            stageKey: components["schemas"]["StageKey"];
            name: string;
            seq: number;
            status: components["schemas"]["StageStatus"];
            plannedStart: components["schemas"]["DateOnly"] & (string | null);
            plannedEnd: components["schemas"]["DateOnly"] & (string | null);
            actualStart: components["schemas"]["DateOnly"] & (string | null);
            actualEnd: components["schemas"]["DateOnly"] & (string | null);
            nodes: components["schemas"]["ProjectNode"][];
        };
        /** @description 阶段状态与完成度（GET /projects/{id}/stages） */
        ProjectStageSummary: {
            id: components["schemas"]["Uuid"];
            stageKey: components["schemas"]["StageKey"];
            name: string;
            seq: number;
            status: components["schemas"]["StageStatus"];
            plannedStart: components["schemas"]["DateOnly"] & (string | null);
            plannedEnd: components["schemas"]["DateOnly"] & (string | null);
            actualStart: components["schemas"]["DateOnly"] & (string | null);
            actualEnd: components["schemas"]["DateOnly"] & (string | null);
            nodes: components["schemas"]["StageProgress"];
            tasks: components["schemas"]["StageProgress"];
            advancedAt: components["schemas"]["DateTime"] & (string | null);
            advancedBy: components["schemas"]["Uuid"] & (string | null);
            rolledBackAt: components["schemas"]["DateTime"] & (string | null);
            rolledBackBy: components["schemas"]["Uuid"] & (string | null);
            rollbackReason: string | null;
            version: components["schemas"]["Version"];
        };
        /**
         * @description 项目状态（projects.status）
         * @enum {string}
         */
        ProjectStatus: "active" | "paused" | "done" | "archived";
        /** @description 项目总览汇总卡统计（任务派生；口径见 v0.2 §2.4 与前端功能需求 §3.4） */
        ProjectSummary: {
            projectId: components["schemas"]["Uuid"];
            slowestStage: components["schemas"]["StageKey"] & (string | null);
            latestStage: components["schemas"]["StageKey"] & (string | null);
            overdue: number;
            done: number;
            total: number;
        };
        ProjectUpdateBody: {
            /**
             * @description 项目编号：建后可修改；同样校验唯一性，重复返回 409 PROJECT_CODE_EXISTS
             * @example CNBJ-20260708-0001
             */
            code?: string;
            name?: string;
            customer?: string | null;
            region?: string;
            projectType?: string;
            /** @description 项目经理（A22 · Push 136）：至少一位、可多位；不传 = 不改、传空数组 = 400；数组顺序 = 展示顺序 */
            managerIds?: components["schemas"]["Uuid"][];
            stageKey?: components["schemas"]["StageKey"];
            /**
             * @description 项目状态（active / paused / done）；archived 不接受 PATCH —— 归档只能走 POST /projects/{id}/archive（ADR-027 门禁 + 清单），确保归档必有清单与留痕
             * @enum {string}
             */
            status?: "active" | "paused" | "done";
            description?: string | null;
            version: components["schemas"]["Version"];
        };
        /** @description 日报内联问题草稿（一次填报 1~N 条；提交时逐条生成问题记录） */
        ReportIssueDraft: {
            /** @description 问题描述（原文；问题记录标题超 500 字截短落库） */
            title: string;
            categories: components["schemas"]["IssueCategoryList"];
            /**
             * Format: uuid
             * @description 问题处理人 / 责任人（缺省 / null = 按归类自动分派责任部门）
             */
            ownerId?: string | null;
            /** @description 解决方案或建议（落问题的 solution） */
            solution?: string;
            /** @description 该问题附图（文件 id；提交时直接挂到生成的问题） */
            photoFileIds?: components["schemas"]["Uuid"][];
        };
        /** @description 业务读面失效提示：仅资源类别，无记录标识或业务数据；客户端按原有鉴权接口静默重取，事件允许合并与丢失，重连及周期补取兜底 */
        ResourceInvalidationPayload: {
            resources: ("projects" | "tasks" | "reports" | "issues" | "files" | "stakeholders" | "templates" | "dicts" | "users" | "audit" | "permissions" | "preferences")[];
        };
        /** @description 常用筛选组合（首页侧栏；按账号存 user_preferences.prefs.homeSavedFilters） */
        SavedHomeFilter: {
            /** @description 组合 id（前端生成 sf- 前缀；跨设备同步后保持不变） */
            id: string;
            /** @description 组合名称（≤ 20 字） */
            name: string;
            /** @description 地区字典码（多值任一命中） */
            regions: string[];
            /** @description 项目类型字典码（多值任一命中） */
            projectTypes: string[];
            /** @description 项目经理 id 列表（用户目录 id；多值任一命中） */
            managerIds: string[];
            timeFrom: components["schemas"]["DateOnly"] & (string | null);
            timeTo: components["schemas"]["DateOnly"] & (string | null);
        };
        /** @description 保存的视图（内容 = 筛选 + 列配置 + 排序 + 分组；仅保存配置、不复制数据） */
        SavedView: {
            id: components["schemas"]["Uuid"];
            ownerId: components["schemas"]["Uuid"] & unknown;
            /** @description 创建者姓名（公共视图列表随行展示） */
            ownerName: string;
            scope: components["schemas"]["ViewScope"];
            /** @description 视图名称（btrim 后 1 ~ 50 字） */
            name: string;
            filters: components["schemas"]["ViewFilters"];
            columns: components["schemas"]["ViewColumns"];
            sort: components["schemas"]["ViewSort"];
            grouping: components["schemas"]["ViewGrouping"];
            /** @description 是否创建者的默认视图（每人至多一条；置位时自动清掉该人其它默认） */
            isDefault: boolean;
            createdAt: components["schemas"]["DateTime"];
            updatedAt: components["schemas"]["DateTime"];
        };
        /** @description 客户端计算的内容哈希；附件上传（未给 taskId / nodeId / docType）命中同项目既有同内容附件时直接秒传复用（reused=true、upload=null，不建新文件 / 会话）；其余命中返回 duplicateHint（A4-04，提示后可确认继续）；complete 时必须回传 */
        Sha256: string;
        /** @description 推进当前阶段：过门禁才生效；失败 422 STAGE_GATE_NOT_PASSED + 缺项明细（不部分推进） */
        StageAdvanceBody: {
            version: components["schemas"]["Version"];
        };
        /**
         * @description 九阶段字典（v0.2 §2.5：售前规划 / 设计开发 / 加工采购 / 组装发货 / 硬件实施 / 软件部署 / 试运行 / 生产阶段 / 验收）
         * @enum {string}
         */
        StageKey: "presale" | "design" | "purchase" | "assembly" | "install" | "deploy" | "trial" | "production" | "acceptance";
        StageListResponse: {
            projectId: components["schemas"]["Uuid"];
            stageKey: components["schemas"]["StageKey"];
            stages: components["schemas"]["ProjectStageSummary"][];
        };
        /** @description 阶段完成度（读时派生，不落库）：已完成 ÷ 总数 */
        StageProgress: {
            total: number;
            done: number;
        };
        /** @description 回退到相邻上一阶段：仅相邻、无门禁、原因必填；projects.stage_key 回移 */
        StageRollbackBody: {
            /** @description 回退原因（必填并留痕；ADR-023） */
            reason: string;
            version: components["schemas"]["Version"];
        };
        /**
         * @description 阶段状态（project_stages.status）
         * @enum {string}
         */
        StageStatus: "pending" | "active" | "done";
        /** @description 干系人台账条目；联系方式等隐私字段按字段级策略裁剪（C3-08，不返回而非打码） */
        Stakeholder: {
            id: components["schemas"]["Uuid"];
            /** @description 干系人姓名 */
            name: string;
            companyType: components["schemas"]["StakeholderCompanyType"];
            /** @description 具体公司名称（A5-02）；需 stakeholder.view，无权时**键不存在**，有权限但空为 null */
            company?: string | null;
            /** @description 职务 / 责任板块；需 stakeholder.view，无权时键不存在 */
            title?: string | null;
            /** @description 电话（含 WhatsApp）；需 stakeholder.contact.view，无权时键不存在（A5-07） */
            phone?: string | null;
            /** @description 微信号；需 stakeholder.contact.view，无权时键不存在（A5-07） */
            wechat?: string | null;
            /** @description 邮箱；需 stakeholder.contact.view，无权时键不存在（A5-07） */
            email?: string | null;
            /** @description 备注；需 stakeholder.manage，无权时键不存在 */
            remark?: string | null;
            /** @description 干系人角色（A5-01 · Push 225 增列）；自由文本，未登记字段级策略 —— 与姓名 / 公司分类同档：登录且可见即返回，空为 null */
            role: string | null;
            createdBy: components["schemas"]["Uuid"] & (string | null);
            /** @description 录入人显示名（清单「填写者」列） */
            createdByName: string | null;
            /** @description 关联项目（A5-03）；按干系人反查 */
            projects: components["schemas"]["StakeholderProjectRef"][];
            createdAt: components["schemas"]["DateTime"];
            updatedAt: components["schemas"]["DateTime"] & unknown;
        };
        /**
         * @description 公司分类（A5-02）：libiao 立镖机器人 / supplier 供应商 / general_contractor 总包单位 / customer 客户
         * @enum {string}
         */
        StakeholderCompanyType: "libiao" | "supplier" | "general_contractor" | "customer";
        /** @description 新增干系人：变更写审计留痕（对象 = stakeholder）；判重提示（姓名 + 手机号）随批量导入（A5-05，lan 线 M8-01）落地，本切片不阻断 */
        StakeholderCreateBody: {
            name: string;
            companyType: components["schemas"]["StakeholderCompanyType"];
            /** @description 具体公司名称；不传则空 */
            company?: string;
            title?: string;
            phone?: string;
            wechat?: string;
            /** @description 邮箱（格式校验在服务端软校验，避免历史数据误拦） */
            email?: string;
            remark?: string;
            /** @description 干系人角色；不传则空 */
            role?: string;
            /** @description 建台账时一并关联的项目（A5-03）；项目不存在 404 */
            projectIds?: components["schemas"]["Uuid"][];
        };
        /** @description 干系人删除结果（软删，不物理删行） */
        StakeholderDeleteResponse: {
            id: components["schemas"]["Uuid"];
            /** @description 恒为 true（软删：deleted_at 置位） */
            deleted: boolean;
        };
        StakeholderListResponse: {
            items: components["schemas"]["Stakeholder"][];
            page: number;
            limit: number;
            total: number;
        };
        /** @description 把干系人关联到项目（幂等）；需 stakeholder.manage 且干系人可见 */
        StakeholderProjectLinkBody: {
            projectId: components["schemas"]["Uuid"] & unknown;
        };
        /** @description 干系人关联的项目（按干系人反查参与项目） */
        StakeholderProjectRef: {
            id: components["schemas"]["Uuid"];
            /** @description 项目编号（projects.code） */
            code: string;
            /** @description 项目名称 */
            name: string;
        };
        /** @description 更新干系人（部分更新；null = 清空该字段）：变更写审计留痕（字段级 before / after） */
        StakeholderUpdateBody: {
            name?: string;
            companyType?: components["schemas"]["StakeholderCompanyType"];
            company?: string | null;
            title?: string | null;
            phone?: string | null;
            wechat?: string | null;
            email?: string | null;
            remark?: string | null;
            role?: string | null;
        };
        /** @description 任务（v0.2 §2.3 tasks；展示态与是否按时交付的派生规则见 §2.4、A12~A14）；阶段与负责人可空、组内位次 sort_index 见 A15 / A18 / A19（Push 124） */
        Task: {
            id: components["schemas"]["Uuid"];
            projectId: components["schemas"]["Uuid"];
            stageKey: components["schemas"]["StageKey"] & (string | null);
            /** @description 组内位次（A19 / A20 · Push 124）：一组 = 同一项目 + 同一阶段（null = 未分组），0 起、密集；看板列内顺序与项目总览排序都按它 */
            sortIndex: number;
            nodeId: components["schemas"]["Uuid"] & (string | null);
            sourceNodeId: components["schemas"]["Uuid"] & (string | null);
            title: string;
            titleEn: string | null;
            /** @description 任务负责人（A23 · Push 136：一位也可、可多位）：数组顺序 = 展示顺序；**空数组 = 「待分配」**（合法中间状态，沿用 A18）；与 ownerNames 同下标一一对应 */
            ownerIds: components["schemas"]["Uuid"][];
            status: components["schemas"]["TaskBaseStatus"];
            displayStatus: components["schemas"]["TaskDisplayStatus"];
            progress: components["schemas"]["TaskProgress"];
            plannedStart: components["schemas"]["DateOnly"] & (string | null);
            plannedEnd: components["schemas"]["DateOnly"] & (string | null);
            actualEnd: components["schemas"]["DateOnly"] & (string | null);
            estimatedDays: number | null;
            headcount: number | null;
            priority: components["schemas"]["Priority"];
            /** @description 要求输出成果文件（ADR-024 多选，Push 143）：取值属十类成果文件字典；服务端按首次出现去重；**空数组 = 不要求**；随模板 / 节点生成后默认锁定（A1-17，例外调整随 M3-05） */
            deliverableTypes: components["schemas"]["DocType"][];
            note: string | null;
            /** @description 是否按时交付（服务端读时派生，A14 · Push 70）：完成且实际完成不晚于预计完成 → true；完成但晚于预计完成，或已完成未填完成日期且预计完成已过 → false；未完成且已过预计完成 → false（配 displayStatus=overdue 即「逾期未交付」）；未完成未到期 / 无预计完成日期 → 派生不出 → 回落迁移导入的存储值，仍无则 null（前端显示「—」）。前端标签「逾期未交付 / 逾期已交付」由本字段 + displayStatus 渲染，不再本地派生 */
            onTime: boolean | null;
            /** @description 变更关联（A1-07 / R01：**一条任务可关联多条变更**，写面「追加＋去重」）：数组顺序 = 关联先后（追加序，末位 = 最近一次变更）；空数组 = 无变更。前端「变更关联」列按本数组渲染多条变更徽标（悬浮显示变更日期） */
            changeLinks: components["schemas"]["TaskChangeLink"][];
            finalizedAt: components["schemas"]["DateTime"] & (string | null);
            finalizedBy: components["schemas"]["Uuid"] & (string | null);
            version: components["schemas"]["Version"];
            createdAt: components["schemas"]["DateTime"];
            updatedAt: components["schemas"]["DateTime"];
        };
        /**
         * @description 任务存储基础态（不写回派生结果）
         * @enum {string}
         */
        TaskBaseStatus: "pending" | "active" | "done";
        /** @description 批量操作（系统功能书 A1-08）：逐条校验 + 逐条独立事务（避免长事务）；部分失败返回失败清单，成功项照常生效 */
        TaskBatchBody: {
            /** @description 目标任务 id（1~100；重复 id 去重后按首次出现顺序逐条处理；不属于本项目的 id 计为该条 not_found，不影响同批其它项） */
            ids: components["schemas"]["Uuid"][];
            changes: components["schemas"]["TaskBatchChanges"];
        };
        /** @description 批量变更字段（白名单；语义同单条编辑：null = 清空、缺键 = 不改；至少给一个键） */
        TaskBatchChanges: {
            /** @description 批量指派负责人（A23）：显式 [] = 全部置为「待分配」；传数组 = 整体替换（顺序 = 展示顺序） */
            ownerIds?: components["schemas"]["Uuid"][];
            status?: components["schemas"]["TaskStatusWrite"];
            plannedStart?: components["schemas"]["DateOnly"] & (string | null);
            /**
             * Format: date
             * @description 批量改期（开始 / 预计完成）；提醒重算随 C2 规则引擎（i8 / i9）
             */
            plannedEnd?: string | null;
            estimatedDays?: number | null;
            headcount?: number | null;
            /**
             * @description 批量改紧急重要度（A1-08）
             * @enum {string|null}
             */
            priority?: "高" | "中" | "低" | null;
            note?: string | null;
        };
        /** @description 批量失败项（逐条校验结果；失败不影响同批成功项） */
        TaskBatchFailure: {
            id: components["schemas"]["Uuid"] & unknown;
            code: components["schemas"]["TaskBatchFailureCode"];
            /** @description 失败原因（可直接展示） */
            message: string;
            /** @description code=gate_not_passed 时的缺件明细（与完成门禁同形：docType / required / present） */
            missing?: components["schemas"]["TaskGateMissing"][];
        };
        /**
         * @description 批量失败原因：not_found 任务不存在 / 不属于该项目 / 已软删；archived 项目已归档；gate_not_passed 完成门禁缺件；already_done 任务已完成；version_conflict 并发写入冲突；invalid_state 其它业务校验失败；finalized 任务已定档（不支持任何修改，Push 249）
         * @enum {string}
         */
        TaskBatchFailureCode: "not_found" | "archived" | "gate_not_passed" | "already_done" | "version_conflict" | "invalid_state" | "finalized";
        /** @description 批量操作结果（整体 200：部分失败不影响成功项，失败清单给出逐条原因） */
        TaskBatchResponse: {
            /** @description 去重后的目标条数 */
            total: number;
            succeededCount: number;
            failedCount: number;
            /** @description 成功项（更新后的任务全量视图，前端按行替换） */
            succeeded: components["schemas"]["Task"][];
            /** @description 失败项清单（含原因；顺序 = 处理顺序） */
            failures: components["schemas"]["TaskBatchFailure"][];
        };
        /** @description 完成预检（canComplete=false 时 missing 给缺件明细） */
        TaskCanCompleteResponse: {
            canComplete: boolean;
            missing: components["schemas"]["TaskGateMissing"][];
            warnings: components["schemas"]["TaskGateWarning"][];
        };
        /** @description 任务 ↔ 变更关联项（多条；列表 / 详情同形） */
        TaskChangeLink: {
            id: components["schemas"]["Uuid"] & unknown;
            /** @description 变更原因（列表下发短文本，超长由服务端截断；全文在变更详情） */
            reason: string | null;
            appliedAt: components["schemas"]["DateTime"] & unknown;
        };
        /** @description 完成提交（乐观锁 version 必传；门禁未通过 422 + missing） */
        TaskCompleteBody: {
            version: components["schemas"]["Version"];
            actualEnd?: components["schemas"]["DateOnly"] & unknown;
            /** @description 完成备注：提供时写入任务的「项目进展描述」（note）并留痕 */
            note?: string;
        };
        /** @description 完成结果（warnings 非空 = 已放行但存在未定档成果文件，R02 已入队） */
        TaskCompleteResponse: {
            task: components["schemas"]["Task"];
            warnings: components["schemas"]["TaskGateWarning"][];
        };
        /** @description 创建任务（进度默认 0、状态默认 pending；从模板生成时与整套添加同口径） */
        TaskCreateBody: {
            /**
             * @description 所属阶段（A15 · Push 124：可选）—— 缺省 / null = 「未分组」（看板「＋ 添加 → 临时任务」）；带 taskNodeId 时缺省取来源节点所属阶段，显式给出且与节点不一致返回 400
             * @enum {string|null}
             */
            stageKey?: "presale" | "design" | "purchase" | "assembly" | "install" | "deploy" | "trial" | "production" | "acceptance" | null;
            /** @description 插入位次（A20 · Push 124）：「插入位置」用 —— 0 起（0 = 组内最前）；越界 / 缺省 = 追加到组尾；同组其余任务顺延 */
            sortIndex?: number;
            /**
             * @description 任务描述（节点名称）
             * @example 货架组装
             */
            title: string;
            titleEn?: string | null;
            taskNodeId?: components["schemas"]["Uuid"] & unknown;
            sourceNodeId?: components["schemas"]["Uuid"] & unknown;
            /** @description 任务负责人：缺省 / 显式 [] = 「待分配」（**2026-09-24 业务口径修订**：任务添加后负责人默认为空 —— 不再兜底项目经理）；传数组 = 整体设置，数组顺序 = 展示顺序 */
            ownerIds?: components["schemas"]["Uuid"][];
            plannedStart?: components["schemas"]["DateOnly"] & (string | null);
            plannedEnd?: components["schemas"]["DateOnly"] & (string | null);
            estimatedDays?: number | null;
            headcount?: number | null;
            priority?: components["schemas"]["Priority"];
            /** @description 要求输出成果文件（ADR-024 多选）：去重（首次出现保序）；缺省 / 空数组 = 不要求 */
            deliverableTypes?: components["schemas"]["DocType"][];
            note?: string | null;
        };
        /** @description 从任务模板生成任务（批量；同一节点在项目里只留一份） */
        TaskCreateFromTemplateBody: {
            templateId: components["schemas"]["Uuid"];
            /** @description 只添加模板内的部分节点（缺省 = 模板全部节点）；必须是该模板包含的节点，否则 400 */
            nodeIds?: components["schemas"]["Uuid"][];
            /**
             * @description 已存在的节点跳过并计入 skipped（默认 true）；false 时遇重复返回 409
             * @default true
             */
            skipExisting: boolean;
            /** @description 任务负责人：缺省 = 「待分配」（2026-09-24 业务口径修订：不再兜底项目经理）；显式 [] 同义 */
            ownerIds?: components["schemas"]["Uuid"][];
            /** @description 起始插入位次（A20）：整批按模板内顺序依次落位（第 k 条 = sortIndex + k）；越界 / 缺省 = 追加到组尾 */
            sortIndex?: number;
            /**
             * @description 生成任务的紧急重要度（可空 = 不写）；节点库暂无「默认紧急重要度」列（A1-17 映射待补），先由调用方给
             * @enum {string|null}
             */
            priority?: "高" | "中" | "低" | null;
        };
        TaskCreateFromTemplateResponse: {
            created: components["schemas"]["Task"][];
            /** @description skipExisting=true 时跳过的节点及其已存在的任务 */
            skipped: {
                nodeId: components["schemas"]["Uuid"];
                taskId: components["schemas"]["Uuid"];
            }[];
        };
        /** @description 任务删除结果（软删）：列表 / 看板 / 甘特图 / 完成门禁一律不可见，来源节点约束随之释放 */
        TaskDeleteResponse: {
            id: components["schemas"]["Uuid"];
            /** @description 恒为 true（软删：tasks.deleted_at 置位，不物理删行；历史与留痕保留） */
            deleted: boolean;
        };
        /** @description 任务详情（M3-01；列表 → 详情不再依赖列表随行数据） */
        TaskDetail: components["schemas"]["Task"] & {
            /** @description 负责人姓名数组：与 ownerIds 同下标一一对应；「待分配」= 空数组 */
            ownerNames: (string | null)[];
            files: components["schemas"]["TaskFileBrief"][];
        };
        /**
         * @description 任务展示五态（服务端读时派生 + 显式覆盖，A12 / A14 · Push 70；2026-09-24 起五态可写）：待开始 / 进行中 / 已完成 / 已延期 / 提前完成；有显式覆盖（tasks.status_override，仅 overdue / early_done 两值）时优先取覆盖值，否则派生 —— 未完成且已过预计完成日期一律「已延期」；「逾期未交付 / 逾期已交付」不进状态列，落在「是否按时交付」（Task.onTime + 本字段）
         * @enum {string}
         */
        TaskDisplayStatus: "pending" | "active" | "done" | "overdue" | "early_done";
        TaskFileBrief: {
            id: components["schemas"]["Uuid"];
            name: string;
            status: components["schemas"]["FileStatus"];
            docType: components["schemas"]["DocType"] & (string | null);
        };
        TaskFileSummary: {
            total: number;
            /** @description 未定档（draft）数量；>0 时完成门禁放行但返回 warning 并触发 R02 */
            draft: number;
            /** @description 已定档（final / changed）数量；门禁按 node_requirements 逐 doc_type 统计 */
            final: number;
        };
        /** @description 任务定档提交（version = 抽屉当前行版本） */
        TaskFinalizeBody: {
            version: components["schemas"]["Version"] & unknown;
        };
        /** @description 缺件明细：required / present 按门禁统计范围逐 doc_type 给出 */
        TaskGateMissing: {
            docType: components["schemas"]["DocType"];
            required: number;
            present: number;
        };
        /** @description 放行提示：存在 draft 成果文件（放行但提示定档，R02 已入队） */
        TaskGateWarning: {
            /** @enum {string} */
            code: "draft_doc_present";
            docType: components["schemas"]["DocType"];
            count: number;
        };
        /** @description 任务（v0.2 §2.3 tasks；展示态与是否按时交付的派生规则见 §2.4、A12~A14）；阶段与负责人可空、组内位次 sort_index 见 A15 / A18 / A19（Push 124） */
        TaskListItem: components["schemas"]["Task"] & {
            /** @description 负责人姓名数组（users.display_name 随行下发，与 ownerIds 同下标一一对应）；「待分配」= 空数组；某位取不到姓名时该位为 null（前端显示「—」） */
            ownerNames: (string | null)[];
            fileSummary: components["schemas"]["TaskFileSummary"];
        };
        /** @description 任务列表（items 为 TaskListItem：表格直接渲染 + 内联摘要） */
        TaskListResponse: {
            items: components["schemas"]["TaskListItem"][];
            page: number;
            limit: number;
            total: number;
        };
        /** @description 锁定字段例外调整（仅系统管理员）：至少给出一个实际变化的字段，否则 400；原因必填并留痕（审计 + task.locked_fields_adjusted） */
        TaskLockedFieldsAdjustBody: {
            version: components["schemas"]["Version"];
            /** @description 例外调整原因（必填并留痕；A1-17 / C9-07） */
            reason: string;
            /** @description 任务描述（中文；锁定字段 —— 仅管理员例外修正） */
            title?: string;
            /** @description 任务描述（英文；锁定项；null = 清空） */
            titleEn?: string | null;
            /** @description 要求输出成果文件（锁定项，多选去重、首次出现保序）：修正后即刻成为完成门禁依据（有节点任务仍以节点 node_requirements 为准，本字段只作无节点任务兜底） */
            deliverableTypes?: components["schemas"]["DocType"][];
        };
        /** @description 任务节点库条目（任务模板的节点来源） */
        TaskNode: {
            id: components["schemas"]["Uuid"];
            stageKey: components["schemas"]["StageKey"];
            /** @description 库内排序（建议 10/20/30 步长，便于插入） */
            seq: number;
            /**
             * @description 节点名称（生成任务时写入任务描述）
             * @example 货架组装
             */
            title: string;
            /** @example Shelf Assembly */
            titleEn: string | null;
            version: components["schemas"]["Version"];
            createdAt: components["schemas"]["DateTime"];
            updatedAt: components["schemas"]["DateTime"];
        };
        /** @description 新增任务节点（管理端） */
        TaskNodeCreateBody: {
            stageKey: components["schemas"]["StageKey"];
            /**
             * @description 节点名称（中文；同阶段内唯一）
             * @example 货架组装
             */
            title: string;
            /** @description 英文名（可空） */
            titleEn?: string | null;
            /** @description 库内排序；缺省 = 追加到该阶段末尾（末位 seq + 10） */
            seq?: number;
        };
        TaskNodeDeleteResponse: {
            id: components["schemas"]["Uuid"];
            deleted: boolean;
        };
        TaskNodeListResponse: {
            items: components["schemas"]["TaskNode"][];
            total: number;
        };
        /** @description 编辑任务节点（改名 / 英文名；乐观锁 version 必传） */
        TaskNodeUpdateBody: {
            /**
             * @description 节点名称（中文；同阶段内唯一）
             * @example 货架组装
             */
            title?: string;
            /** @description 英文名（可空；显式 null = 清空） */
            titleEn?: string | null;
            version: components["schemas"]["Version"];
        };
        /** @description 任务进度四格（离散五档）：0 / 25% / 50% / 75% / 100%；写入即联动状态与完成日期 */
        TaskProgress: 0 | 0.25 | 0.5 | 0.75 | 1;
        TaskProgressUpdateBody: {
            progress: components["schemas"]["TaskProgress"];
            actualEnd?: components["schemas"]["DateOnly"] & unknown;
            /** @description 进度更新备注：提供时写入任务的「项目进展描述」（note）并留痕 */
            note?: string;
            version: components["schemas"]["Version"];
        };
        /**
         * @description 批量改状态（五态可选，口径同单条编辑）：done = 批量完成（逐条走同一完成门禁，缺件项进 failures 的 gate_not_passed）；overdue / early_done = 显式覆盖
         * @enum {string}
         */
        TaskStatusWrite: "pending" | "active" | "done" | "overdue" | "early_done";
        /**
         * @description 任务表列 key（白名单；「任务描述」常显，不在其中）
         * @enum {string}
         */
        TaskTableColumnKey: "manager" | "owner" | "status" | "priority" | "onTime" | "deliverable" | "files" | "note" | "start" | "days" | "due" | "headcount" | "doneDate" | "change";
        /** @description 任务模板（名称 + 阶段 + 节点顺序；A1-16 / A1-17 的落点） */
        TaskTemplate: {
            id: components["schemas"]["Uuid"];
            /**
             * @description 模板名称（列头可直接改名）
             * @example 英国订单
             */
            name: string;
            stageKey: components["schemas"]["StageKey"];
            /** @description 节点顺序 = 数组顺序；同一模板内按 nodeId 去重 */
            nodes: components["schemas"]["TaskTemplateNode"][];
            version: components["schemas"]["Version"];
            createdAt: components["schemas"]["DateTime"];
            updatedAt: components["schemas"]["DateTime"];
        };
        TaskTemplateCreateBody: {
            name: string;
            stageKey: components["schemas"]["StageKey"];
            /**
             * @description 任务节点库内的节点 id，顺序即模板内顺序；允许空（新建后逐步添加）；重复 id 返回 400
             * @default []
             */
            nodeIds: components["schemas"]["Uuid"][];
        };
        TaskTemplateDeleteBody: {
            version: components["schemas"]["Version"];
        };
        /** @description 删除即生效；已生成的受影响项目任务不变 */
        TaskTemplateDeleteResponse: {
            id: components["schemas"]["Uuid"];
            deletedAt: components["schemas"]["DateTime"];
        };
        TaskTemplateListResponse: {
            items: components["schemas"]["TaskTemplate"][];
            total: number;
        };
        /** @description 模板内节点（引用任务节点库 + 模板内顺序 + 名称摘要） */
        TaskTemplateNode: {
            nodeId: components["schemas"]["Uuid"];
            seq: number;
            title: string;
            titleEn: string | null;
        };
        /** @description 编辑模板（改名 / 节点全量替换；乐观锁 version 必传） */
        TaskTemplateUpdateBody: {
            name?: string;
            /** @description 全量替换节点顺序（含增删 / 重排）；同一模板内按 id 去重，重复 id 返回 400 */
            nodeIds?: components["schemas"]["Uuid"][];
            version: components["schemas"]["Version"];
        };
        /** @description 任务取消定档提交（version = 抽屉当前行版本） */
        TaskUnfinalizeBody: {
            version: components["schemas"]["Version"] & unknown;
        };
        /** @description 编辑任务（乐观锁 version 必传；阶段不在本接口；status 支持五态并联动进度与完成日期，进度 / 完成日期仍走 /progress；ownerIds 显式 [] = 待分配、传数组 = 整体替换，sortIndex = 组内重排）；title / titleEn（Push 196）仅**未归入阶段**的临时任务可改，阶段任务 / 节点 / 模板生成的任务仍锁定（带字段请求 400）；deliverableTypes（2026-10-08 起）常规编辑开放，原「生成后锁定 / 仅管理员例外调整」下架 */
        TaskUpdateBody: {
            /** @description 任务描述（中文；Push 196）：仅**无来源节点**的任务可改（看板「添加 → 临时任务」手工创建）；节点 / 模板生成的任务按 A1-17 锁定，带该字段请求 400 */
            title?: string;
            /** @description 任务描述（英文；Push 196）：与 title 同一门禁；null = 清空 */
            titleEn?: string | null;
            /** @description 任务负责人（A23 · Push 136）：不传 = 不改；显式 [] = 置空为「待分配」（卡片拖进「待分配」列）；传数组 = 整体替换、顺序 = 展示顺序 */
            ownerIds?: components["schemas"]["Uuid"][];
            /** @description 组内位次（A19 / A20 · Push 124）：把任务移到该组第 N 位（0 起，越界 = 组尾）—— 同组其余任务位次顺延；不传 = 不动顺序 */
            sortIndex?: number;
            status?: components["schemas"]["TaskStatusWrite"] & unknown;
            plannedStart?: components["schemas"]["DateOnly"] & (string | null);
            plannedEnd?: components["schemas"]["DateOnly"] & (string | null);
            estimatedDays?: number | null;
            headcount?: number | null;
            priority?: components["schemas"]["Priority"];
            /** @description 要求输出成果文件（2026-10-08 业务口径「文件输出成果也要可以选择」）：常规编辑开放 —— 传数组 = 整体替换（去重、首次出现保序）；显式 [] = 不要求；缺省 = 不改 */
            deliverableTypes?: components["schemas"]["DocType"][];
            note?: string | null;
            version: components["schemas"]["Version"];
        };
        /** @description 批量查库请求（英文界面切页提速；只回已存译文） */
        TranslateBatchBody: {
            qs: string[];
            source?: components["schemas"]["TranslateLang"];
            target?: components["schemas"]["TranslateLang"];
        };
        TranslateBatchResponse: {
            /** @description 命中条目（译文库已存；未命中的由前端走单条通道） */
            translations: {
                /** @description 原文（请求时原样回显） */
                q: string;
                /** @description 已存译文 */
                translatedText: string;
            }[];
        };
        /** @description 单条翻译请求：译文库优先、未命中调引擎后落库 */
        TranslateBody: {
            q: string;
            source?: components["schemas"]["TranslateLang"];
            target?: components["schemas"]["TranslateLang"];
            /**
             * @default text
             * @enum {string}
             */
            format: "text";
        };
        /**
         * @description 语言：zh 中文 / en 英文
         * @default zh
         * @enum {string}
         */
        TranslateLang: "zh" | "en";
        TranslateResponse: {
            /** @description 译文（译文库命中或引擎产出后落库） */
            translatedText: string;
        };
        UploadAbortResponse: {
            upload: components["schemas"]["UploadSession"] & unknown;
        };
        UploadCompleteBody: {
            contentHash: components["schemas"]["Sha256"] & unknown;
        };
        UploadCompleteResponse: {
            file: components["schemas"]["File"];
            version: components["schemas"]["FileVersion"];
            changeRequest: components["schemas"]["ChangeRequest"];
        };
        /** @description 发起上传（分片直传；返回预签名分片 URL 的获取入口）。intent=version：fileId 省略 = 新建文件、给出 = 对既有 draft 文件替换 / 追加版本；intent=change：fileId 必填 = 定档后变更（申请即通过，完成上传时同事务生效；name = 变更后文件名称 —— 完成时文件更名为该名称） */
        UploadCreateBody: {
            projectId: components["schemas"]["Uuid"];
            /** @description 文件名：fileId 省略（新建）= 新文件名；intent=version 且给出 fileId = 目标文件名称（须与现状一致，不一致 400）；intent=change = 变更后文件名称（Push 256：必填，可不同于目标文件名 —— 完成变更时文件更名为该名称，扩展名随之更新，预览 / 下载按新名称） */
            name: string;
            /** @description 字节数；上限由服务端配置（UPLOAD_MAX_SIZE_MB），超出返回 400 VALIDATION_FAILED */
            sizeBytes: number;
            mime?: string;
            contentHash?: components["schemas"]["Sha256"];
            docType?: components["schemas"]["DocType"];
            nodeId?: components["schemas"]["Uuid"];
            taskId?: components["schemas"]["Uuid"];
            /** @enum {string} */
            intent: "version";
            fileId?: components["schemas"]["Uuid"] & unknown;
        } | {
            projectId: components["schemas"]["Uuid"];
            /** @description 文件名：fileId 省略（新建）= 新文件名；intent=version 且给出 fileId = 目标文件名称（须与现状一致，不一致 400）；intent=change = 变更后文件名称（Push 256：必填，可不同于目标文件名 —— 完成变更时文件更名为该名称，扩展名随之更新，预览 / 下载按新名称） */
            name: string;
            /** @description 字节数；上限由服务端配置（UPLOAD_MAX_SIZE_MB），超出返回 400 VALIDATION_FAILED */
            sizeBytes: number;
            mime?: string;
            contentHash?: components["schemas"]["Sha256"];
            docType?: components["schemas"]["DocType"];
            nodeId?: components["schemas"]["Uuid"];
            taskId?: components["schemas"]["Uuid"];
            /** @enum {string} */
            intent: "change";
            fileId: components["schemas"]["Uuid"] & unknown;
            change: components["schemas"]["ChangeIntentBody"];
        };
        /** @description 发起上传结果：新建 / 追加版本返回上传会话；附件域命中同内容既有文件则秒传复用（reused=true、upload=null） */
        UploadCreateResponse: {
            file: components["schemas"]["File"];
            upload: components["schemas"]["UploadSession"];
            /** @description 是否复用了同项目既有的同内容附件（2026-10-12 口径）：true = 未新建文件、未建会话（file = 既有文件）；任务成果上传（带 taskId 等归属）恒 false */
            reused: boolean;
            duplicateHint: components["schemas"]["DuplicateHint"];
        };
        /**
         * @description 上传意图：version = 新增/替换版本（仅 draft 文件）；change = 定档后变更（同一事务写 change_requests + 新版本 + 状态 changed）；**目标任务已定档（Task.finalizedAt 非空）时 version 意图一律 409 TASK_FINALIZED**（Push 249：任务定档后不支持任何修改，修改走变更）
         * @enum {string}
         */
        UploadIntent: "version" | "change";
        /** @description 批量获取分片预签名 URL（首传与断点续传共用；续传前先查会话状态拿缺失分片） */
        UploadPartsBody: {
            partNumbers: number[];
        };
        UploadPartsResponse: {
            uploadId: components["schemas"]["Uuid"];
            partSizeBytes: number;
            parts: components["schemas"]["UploadPartUrl"][];
            expiresAt: components["schemas"]["DateTime"];
        };
        UploadPartUrl: {
            partNumber: number;
            /** @description 预签名 PUT URL（浏览器直传对象存储，api 不代理大文件流量） */
            url: string;
            expiresAt: components["schemas"]["DateTime"];
        };
        /** @description 上传会话；附件域秒传复用命中时 = null（无需传分片，直接把 file.id 挂到日报 / 问题等对象） */
        UploadSession: {
            id: components["schemas"]["Uuid"];
            fileId: components["schemas"]["Uuid"];
            intent: components["schemas"]["UploadIntent"];
            partSizeBytes: number;
            totalParts: number;
            status: components["schemas"]["UploadSessionStatus"];
            createdAt: components["schemas"]["DateTime"];
            expiresAt: components["schemas"]["DateTime"];
        } | null;
        /**
         * @description 上传会话状态；active 可续传，completed/aborted/expired 不可再用
         * @enum {string}
         */
        UploadSessionStatus: "active" | "completed" | "aborted" | "expired";
        /** @description 上传会话（服务端只登记元数据；分片状态以对象存储 ListParts 为准） */
        UploadSessionView: components["schemas"]["UploadSession"] & {
            /** @description 已上传分片（来自对象存储 ListParts） */
            uploadedPartNumbers: number[];
            /** @description 缺失分片（断点续传只补这些） */
            missingPartNumbers: number[];
        };
        /** @description 登录用户（SSO 归一化口径，ADR-010） */
        User: {
            /**
             * @description Casdoor 用户 ID（claims.id → users.casdoor_id）
             * @example a195b721bb30a7d4
             */
            id: string | null;
            /**
             * @description 工号（claims.name → users.username）
             * @example A0001
             */
            name: string | null;
            /**
             * @description 姓名（claims.displayName → users.display_name）
             * @example 张三
             */
            displayName: string | null;
            /** @example zhangsan@libiaorobot.com */
            email: string | null;
            /**
             * @description 所属组织（claims.owner）
             * @example libiaorobot.com
             */
            owner: string | null;
        };
        UserListResponse: {
            items: components["schemas"]["UserSummary"][];
            page: number;
            limit: number;
            total: number;
        };
        /** @description 用户偏好（全量；GET 返回当前值） */
        UserPreferences: {
            /** @description 任务表隐藏列 key 列表（白名单 = TaskTableColumnKey，「任务描述」常显；未知 key 400 VALIDATION_FAILED；整体替换语义） */
            taskTableHiddenColumns: components["schemas"]["TaskTableColumnKey"][];
            /** @description 常用筛选组合（最多 20 组；整体替换语义） */
            homeSavedFilters: components["schemas"]["SavedHomeFilter"][];
            /** @description 醒目模式（A4 · §6.13，Push 171）：true = 项目总览任务表每行铺该任务状态的底色；默认 false；读侧非布尔一律收敛为 false */
            focusMode: boolean;
            workspaceOpenProjects: components["schemas"]["WorkspaceOpenProjects"];
            myPlanBoard: components["schemas"]["MyPlanBoard"];
            /** @description 偏好各键的基线版本；未写过的键为0 */
            revisions: {
                [key: string]: number;
            };
            backgroundTier: components["schemas"]["BackgroundTier"];
            locale: components["schemas"]["Locale"];
            /** @description 项目卡片右下角国家名水印（Push 292 · 业务口径 2026-10-13「增加一个水印选项 可以选择是否要水印」；Push 313 起默认 false）：true = 显示 / false = 隐藏（默认，无水印）；读侧非布尔 / 缺省一律收敛为 false */
            cardWatermark: boolean;
            hubView: components["schemas"]["HubView"];
            hubDashProject: components["schemas"]["HubDashProject"];
            hubDashView: components["schemas"]["HubDashView"];
            updatedAt: components["schemas"]["DateTime"] & (string | null);
        };
        /** @description PATCH在账号行锁事务内合并变更键（数组键整体替换）；homeSavedFilters/myPlanBoard必须带expectedRevisions对应基线，缺失400、冲突409；保留其它键，禁止写内部_revisions；列key需在白名单，focusMode/cardWatermark为布尔，backgroundTier/locale/hubView/hubDashView需在枚举内，hubDashProject为1..64字符或null，否则400 */
        UserPreferencesUpdateBody: {
            taskTableHiddenColumns?: components["schemas"]["TaskTableColumnKey"][];
            homeSavedFilters?: components["schemas"]["SavedHomeFilter"][];
            focusMode?: boolean;
            workspaceOpenProjects?: components["schemas"]["WorkspaceOpenProjects"];
            myPlanBoard?: components["schemas"]["MyPlanBoardUpdate"];
            /** @description 更新homeSavedFilters/myPlanBoard时必须带对应基线版本，缺失400、冲突409；服务端行锁合并。内部_revisions禁止客户端写入。 */
            expectedRevisions?: {
                homeSavedFilters?: number;
                myPlanBoard?: number;
            };
            backgroundTier?: components["schemas"]["BackgroundTier"] & unknown;
            locale?: components["schemas"]["Locale"] & unknown;
            cardWatermark?: boolean;
            hubView?: components["schemas"]["HubView"] & unknown;
            hubDashProject?: components["schemas"]["HubDashProject"] & unknown;
            hubDashView?: components["schemas"]["HubDashView"] & unknown;
        } & {
            [key: string]: unknown;
        };
        /**
         * @description 用户状态；非 active 时该用户全部会话被撤销
         * @enum {string}
         */
        UserStatus: "active" | "disabled";
        /** @description 用户目录项（M1：项目经理下拉 / 任务负责人候选 / 姓名解析） */
        UserSummary: {
            id: components["schemas"]["Uuid"];
            /**
             * @description 工号（users.username，唯一）
             * @example 10086
             */
            username: string;
            /** @description 姓名（users.display_name） */
            displayName: string;
            email: string | null;
            status: components["schemas"]["UserStatus"];
        };
        /**
         * Format: uuid
         * @description UUID（主键与关联 ID）
         */
        Uuid: string;
        /** @description 乐观锁版本：读取时返回，更新时必须原样回传，冲突返回 409 */
        Version: number;
        /** @description 列配置（列键数组；顺序 = 展示顺序；列键白名单由前端列定义维护） */
        ViewColumns: string[];
        /** @description 新建视图（A1-03：筛选 + 列配置 + 排序 + 分组） */
        ViewCreateBody: {
            /** @description 视图名称（前后空白剔除后 1 ~ 50 字） */
            name: string;
            scope?: components["schemas"]["ViewScope"];
            filters?: components["schemas"]["ViewFilters"];
            columns?: components["schemas"]["ViewColumns"];
            sort?: components["schemas"]["ViewSort"];
            grouping?: components["schemas"]["ViewGrouping"];
            /**
             * @description 建为我的默认视图（置位时自动清掉该人其它默认）
             * @default false
             */
            isDefault: boolean;
        };
        /** @description 视图删除结果（物理删） */
        ViewDeleteResponse: {
            id: components["schemas"]["Uuid"];
            /** @description 恒为 true（视图是配置文件，物理删、不留痕） */
            deleted: boolean;
        };
        /** @description 筛选条件（扁平键值，最多 30 键；键 = 任务表 URL 参数名，如 stageKey / ownerId / displayStatus / keyword） */
        ViewFilters: {
            [key: string]: components["schemas"]["ViewFilterValue"];
        };
        /** @description 筛选值：字符串 / 数字 / 布尔 / 字符串数组（多值）/ null（显式清空） */
        ViewFilterValue: string | number | boolean | string[] | null;
        /** @description 分组方式 */
        ViewGrouping: {
            /** @description 分组键（如 stage / owner / status / project） */
            key: string;
        } | null;
        /** @description 视图清单（无分页：个人 + 公共视图量级小） */
        ViewListResponse: {
            /** @description 可见视图清单（排序：个人在前 → updatedAt 降序 → id 升序） */
            items: components["schemas"]["SavedView"][];
        };
        /**
         * @description 视图范围：personal 个人视图（仅本人可见 / 可改）/ public 公共视图（全员可见，创建者可改；角色级共享未做，差异登记）
         * @enum {string}
         */
        ViewScope: "personal" | "public";
        /** @description 排序方式（键 + 方向） */
        ViewSort: {
            /** @description 排序键（白名单由目标列表维护） */
            key: string;
            /**
             * @description 升序 / 降序
             * @enum {string}
             */
            order: "asc" | "desc";
        } | null;
        /** @description 更新视图（局部更新：只传变更键；空更新 400 VALIDATION_FAILED） */
        ViewUpdateBody: {
            name?: string;
            scope?: components["schemas"]["ViewScope"];
            filters?: components["schemas"]["ViewFilters"];
            columns?: components["schemas"]["ViewColumns"];
            sort?: components["schemas"]["ViewSort"];
            grouping?: components["schemas"]["ViewGrouping"];
            isDefault?: boolean;
        };
        /** @description 当前仍有效的（pending）绑定码 —— 刷新 / 重进页面后据此恢复码面与倒计时；无未用码 = null */
        WecomDmBindingCode: {
            /**
             * @description 6 位数字绑定码（用户在企微里把这条码发给机器人完成绑定）
             * @example 482913
             */
            code: string;
            expiresAt: components["schemas"]["DateTime"] & unknown;
            /** @description 剩余有效期（秒；供前端倒计时） */
            expiresInSeconds: number;
        } | null;
        /** @description 企业微信单聊绑定态：绑定按机器人维度成立（换机器人后旧绑定不生效 → 读面回到 bound:false）；解绑 = 注销投递资格（保留激活登记）；另回当前未用绑定码与取码限流可重试时刻（页面刷新不丢状态） */
        WecomDmBindingState: {
            /** @description 当前机器人（`WECOM_BOT_ID`）下是否已有可投递地址 */
            bound: boolean;
            /** @description 企微 open_userid 掩码（只回末 4 位）；未绑定 / 解绑后 = null */
            wecomUseridMasked: string | null;
            boundAt: components["schemas"]["DateTime"] & (string | null);
            bindingCode: components["schemas"]["WecomDmBindingCode"];
            retryAt: components["schemas"]["DateTime"] & (string | null);
        };
        /** @description 工作台问题项（跨项目；问题追踪七列数据源随行下发） */
        WorkspaceIssueItem: {
            id: components["schemas"]["Uuid"];
            projectId: components["schemas"]["Uuid"];
            projectCode: string;
            projectName: string;
            taskId: components["schemas"]["Uuid"] & (string | null);
            title: string;
            categories: components["schemas"]["IssueCategoryList"] & unknown;
            state: components["schemas"]["IssueState"];
            reporterId: components["schemas"]["Uuid"];
            reporterName: string | null;
            ownerDepartment: string | null;
            ownerId: components["schemas"]["Uuid"] & (string | null);
            ownerName: string | null;
            raisedAt: components["schemas"]["DateOnly"] & unknown;
            /** @description 解决方案或建议（A3-13；2026-10-13 全字段修订随行下发，工作台「提出/负责的问题」表直接渲染） */
            solution: string | null;
            /** @description 问题附图（file_links(object_type=issue)，插入序；2026-10-13 全字段修订随行下发，工作台表直接渲染） */
            photos: components["schemas"]["FilePhotoRef"][];
            updatedAt: components["schemas"]["DateTime"];
            version: components["schemas"]["Version"];
        };
        /** @description 我的问题两栏（A6-03）；同一问题两边都命中时两个清单都出现；未关闭在前、已完成后置 */
        WorkspaceIssues: {
            /** @description 我处理的（ownerId = 会话用户） */
            handling: components["schemas"]["WorkspaceIssueItem"][];
            /** @description 我提出的（reporterId = 会话用户） */
            raised: components["schemas"]["WorkspaceIssueItem"][];
        };
        /** @description 工作台折叠面板展开态（A31 · Push 233 · 业务口径「这个下拉要有记忆」）：按标签分记已展开的项目 id；默认两空数组 = 全部收起；读侧坏形状收敛为空数组（整体替换语义） */
        WorkspaceOpenProjects: {
            /** @description 「我的任务」标签已展开的项目 id 列表（整体替换语义） */
            tasks: components["schemas"]["Uuid"][];
            /** @description 「我提出的问题」标签已展开的项目 id 列表（整体替换语义） */
            raised: components["schemas"]["Uuid"][];
        };
        /** @description 工作台聚合：我的任务四组 + 我的问题两栏 + 涉及项目卡 */
        WorkspaceResponse: {
            today: components["schemas"]["DateOnly"] & unknown;
            myTasks: components["schemas"]["WorkspaceTasks"];
            myIssues: components["schemas"]["WorkspaceIssues"];
            /** @description 聚合涉及的项目卡（我的任务或我的问题命中的项目，按首次出现顺序去重；含 managerNames / managerIds / version）—— 2026-10-13 全字段修订：工作台行内「项目经理」列与项目经理回写不再逐项目回查 */
            projects: components["schemas"]["Project"][];
        };
        /** @description 工作台任务项（跨项目；按预计完成日期落入四组之一；任务表 15 列数据源随行下发） */
        WorkspaceTaskItem: components["schemas"]["TaskListItem"] & {
            /** @description 项目编号（跨项目列表直接展示） */
            projectCode: string;
            projectName: string;
            /** @description 任务随行文件清单（口径同任务详情 files：排除回收站、创建时间倒序；工作台行内「文件」列下拉的数据源） */
            files: components["schemas"]["TaskFileBrief"][];
        };
        /** @description 我的任务四组（A6-01；组内按 plannedEnd 升序、id 升序，未排期置末） */
        WorkspaceTasks: {
            /** @description 今日待办：plannedEnd = 今天且未完成 */
            today: components["schemas"]["WorkspaceTaskItem"][];
            /** @description 即将到期：plannedEnd > 今天且未完成（2026-09-30 复评起不设天数窗口，远期照收） */
            upcoming: components["schemas"]["WorkspaceTaskItem"][];
            /** @description 已逾期：plannedEnd < 今天且未完成 */
            overdue: components["schemas"]["WorkspaceTaskItem"][];
            /** @description 未排期：plannedEnd 为空且未完成（组内排末） */
            unscheduled: components["schemas"]["WorkspaceTaskItem"][];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
