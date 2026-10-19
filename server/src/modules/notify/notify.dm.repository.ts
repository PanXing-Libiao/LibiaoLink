/**
 * wecom_aibot（智能机器人单聊）数据访问（M5-03-5-3 · 计划 §3.2 ~ §3.5 / D4；M5-03-5-6 绑定码链路）。
 * 边界（ADR 架构检查）：notify 属 PLATFORM —— 本层不得 import identity 模块，直接读 `db/schema/identity.ts`
 * 的 users 表（表访问允许，先例 notify.app.repository.ts / outbox/automation-subjects.ts）。
 * userid 口径（M5-03-5-6 起）：单聊发送地址 = 绑定行的 wecom_userid（回调 from.userid 原文 = 密文
 * open_userid）；`users.username`（明文）不再参与单聊寻址、也不做反查回填（只保留 SSO 与 wecom_app 备用
 * 通道用途）；机器人维度 = bot_id（WECOM_BOT_ID 原文），读写两侧一律按 (bot_id, wecom_userid) 成对。
 * 激活表口径（0048 + 0055）：bound_at 非空 = 绑定行 = 可投递地址（绑定码命中时写入）；user_id 可空（D1
 * 仅激活登记行无主）；first_activated_at 首次不覆盖、last_message_at 随回调 upsert 刷新（语义 = 用户消息
 * 时刻）；发送成功旁证回填（D4）只补 user_id / updated_at，不动 last_message_at。
 * 绑定码口径（0055 · D3 修订 v1.8）：6 位数字 / TTL 5 分钟 / 一次性 / 同一 user_id 仅一个 pending（重发先作废旧码）；
 * 用户消息正文不入库、不落日志 —— 本层只按码取值（CONTRIBUTING §12）。
 * 留痕口径：每次尝试一行（0046 CHECK：非 sent 行必须带非空 error；sent ↔ sentAt 非空且 error 为空）。
 */
import { Injectable } from "@nestjs/common";
import { and, desc, eq, gt, gte, isNotNull, ne, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { users } from "../../db/schema/identity.js";
import { notifyDeliveries, wecomAibotDmActivations, wecomIdBindingCodes } from "../../db/schema/notify.js";

/** 单聊收件人（用户生命周期判定用；发送地址不在此结构 —— 见绑定行）。 */
export interface WecomDmContact {
  id: string;
  status: string;
  removedAt: Date | null;
}

/** 激活行（846607 分流 / 旁证回填判重读面）。 */
export interface DmActivationRow {
  wecomUserid: string;
  userId: string | null;
  firstActivatedAt: Date;
  lastMessageAt: Date;
}

/** 绑定行（发送寻址）：bound_at 非空且 user_id 非空 = 可投递地址（绑定码链路的产物）。 */
export interface DmBindingRow {
  wecomUserid: string;
  userId: string;
  boundAt: Date;
}

/** 绑定码行（ingest 判定 / 频率限制读面）。 */
export interface DmBindingCodeRow {
  id: number;
  code: string;
  userId: string;
  status: string;
  expiresAt: Date;
}

/** 投递留痕输入（服务层保证 CHECK 语义：sent ↔ sentAt 非空且 error 为空）。 */
export interface NotifyDmDeliveryInsert {
  outboxId: number | null;
  target: string;
  state: "sent" | "failed" | "deferred" | "dead";
  attempts: number;
  error: string | null;
  sentAt: Date | null;
}

@Injectable()
export class NotifyDmRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 读收件人（不存在 = null；停用 / 软删由服务层判定）。 */
  async findContact(userId: string, client: DbClient = this.database.db): Promise<WecomDmContact | null> {
    const rows = await client
      .select({ id: users.id, status: users.status, removedAt: users.removedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 激活态读（846607 分流 / 旁证回填判重）：按 (bot_id, wecom_userid) 命中 = 该机器人下已登记激活
   * （D1 登记行与绑定行都算命中 —— 绑定行必然激活）。
   */
  async findActivation(wecomUserid: string, botId: string, client: DbClient = this.database.db): Promise<DmActivationRow | null> {
    const rows = await client
      .select({
        wecomUserid: wecomAibotDmActivations.wecomUserid,
        userId: wecomAibotDmActivations.userId,
        firstActivatedAt: wecomAibotDmActivations.firstActivatedAt,
        lastMessageAt: wecomAibotDmActivations.lastMessageAt,
      })
      .from(wecomAibotDmActivations)
      .where(and(eq(wecomAibotDmActivations.botId, botId), eq(wecomAibotDmActivations.wecomUserid, wecomUserid)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 发送寻址（M5-03-5-6 · 口径 §7 核心变更）：按库内用户 + 当前机器人取绑定行；无绑定行 = 不可投递。 */
  async findBindingByUserId(userId: string, botId: string, client: DbClient = this.database.db): Promise<DmBindingRow | null> {
    const rows = await client
      .select({
        wecomUserid: wecomAibotDmActivations.wecomUserid,
        userId: wecomAibotDmActivations.userId,
        boundAt: wecomAibotDmActivations.boundAt,
      })
      .from(wecomAibotDmActivations)
      .where(
        and(
          eq(wecomAibotDmActivations.botId, botId),
          eq(wecomAibotDmActivations.userId, userId),
          isNotNull(wecomAibotDmActivations.boundAt),
        ),
      )
      .orderBy(desc(wecomAibotDmActivations.boundAt))
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.userId === null || row.boundAt === null) {
      return null;
    }
    return { wecomUserid: row.wecomUserid, userId: row.userId, boundAt: row.boundAt };
  }

  /**
   * 该企微号在当前机器人上的绑定行（v1.8 换绑判据）：码命中时用来取「旧持有者」（与码持有者不同 = 跨用户
   * 换绑），亦用于回调重复投递的幂等判定（码已用 + 绑定仍归码持有者 → 回「绑定成功」）。
   */
  async findBindingByWecomUserid(wecomUserid: string, botId: string, client: DbClient = this.database.db): Promise<DmBindingRow | null> {
    const rows = await client
      .select({
        wecomUserid: wecomAibotDmActivations.wecomUserid,
        userId: wecomAibotDmActivations.userId,
        boundAt: wecomAibotDmActivations.boundAt,
      })
      .from(wecomAibotDmActivations)
      .where(
        and(
          eq(wecomAibotDmActivations.botId, botId),
          eq(wecomAibotDmActivations.wecomUserid, wecomUserid),
          isNotNull(wecomAibotDmActivations.boundAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.userId === null || row.boundAt === null) {
      return null;
    }
    return { wecomUserid: row.wecomUserid, userId: row.userId, boundAt: row.boundAt };
  }

  /**
   * 解绑（D6 · 口径 §4）：把当前机器人下该用户的绑定行去址 —— `bound_at` / `user_id` 置空
   * （保留激活登记行，语义与「换绑清旧」同形：注销投递资格，激活痕迹仍在）。
   * 返回清除行数（0 = 本就无绑定 → 调用方按幂等收口、不写审计）。
   */
  async clearBindingByUserId(
    input: { botId: string; userId: string; at: Date },
    client: DbClient = this.database.db,
  ): Promise<number> {
    const rows = await client
      .update(wecomAibotDmActivations)
      .set({ userId: null, boundAt: null, updatedAt: input.at })
      .where(
        and(
          eq(wecomAibotDmActivations.botId, input.botId),
          eq(wecomAibotDmActivations.userId, input.userId),
          isNotNull(wecomAibotDmActivations.boundAt),
        ),
      )
      .returning({ id: wecomAibotDmActivations.id });
    return rows.length;
  }

  /**
   * 回调 ingest 登记（D1）：单聊用户消息（cmd=aibot_msg_callback · chattype=single）→ upsert（幂等）——
   * 新建或刷新 last_message_at；first_activated_at 首次后不覆盖；**不碰 user_id / bound_at**（绑定只由
   * 绑定码链路写入 —— 本登记行不可作发送地址）。
   */
  async upsertActivationFromCallback(
    input: { botId: string; wecomUserid: string; at: Date },
    client: DbClient = this.database.db,
  ): Promise<void> {
    await client
      .insert(wecomAibotDmActivations)
      .values({
        botId: input.botId,
        wecomUserid: input.wecomUserid,
        firstActivatedAt: input.at,
        lastMessageAt: input.at,
        createdAt: input.at,
        updatedAt: input.at,
      })
      .onConflictDoUpdate({
        target: [wecomAibotDmActivations.botId, wecomAibotDmActivations.wecomUserid],
        set: {
          lastMessageAt: input.at,
          updatedAt: input.at,
        },
      });
  }

  /**
   * 发送成功旁证回填（D4）：行缺失 → 新建（first / last 都记回填时刻，语义 =「已知激活时刻」近似 ——
   * 表内不区分来源，登记为已知近似）；行已存在 → 只补 user_id / updated_at（不动 last_message_at）。
   * 绑定码口径下正常路径不再触发（绑定行必带 user_id）—— 保留为并发删行等异常路径的兜底。
   */
  async backfillActivationOnSend(
    input: { botId: string; wecomUserid: string; userId: string; at: Date },
    client: DbClient = this.database.db,
  ): Promise<void> {
    await client
      .insert(wecomAibotDmActivations)
      .values({
        botId: input.botId,
        wecomUserid: input.wecomUserid,
        userId: input.userId,
        firstActivatedAt: input.at,
        lastMessageAt: input.at,
        createdAt: input.at,
        updatedAt: input.at,
      })
      .onConflictDoUpdate({
        target: [wecomAibotDmActivations.botId, wecomAibotDmActivations.wecomUserid],
        set: {
          userId: sql`coalesce(${wecomAibotDmActivations.userId}, ${input.userId})`,
          updatedAt: input.at,
        },
      });
  }

  /** 窗口内已生成绑定码的创建时刻（升序 —— D3 修订 v1.8：5 次 / 3 分钟 / 用户；空数组 = 未取过码）。 */
  async bindingCodesSince(userId: string, since: Date, client: DbClient = this.database.db): Promise<Date[]> {
    const rows = await client
      .select({ createdAt: wecomIdBindingCodes.createdAt })
      .from(wecomIdBindingCodes)
      .where(and(eq(wecomIdBindingCodes.userId, userId), gte(wecomIdBindingCodes.createdAt, since)))
      .orderBy(wecomIdBindingCodes.createdAt);
    return rows.map((row) => row.createdAt);
  }

  /**
   * 生成绑定码（同一事务 · D3「同一 user_id 仅一个 pending 码」）：先把该用户旧 pending 码作废（expired）
   * 再插入新码；码撞唯一键 → `onConflictDoNothing` 不落行，返回 false 由调用方换码重试。
   */
  async createBindingCode(
    input: { userId: string; code: string; expiresAt: Date; at: Date },
    client: DbClient = this.database.db,
  ): Promise<boolean> {
    return await client.transaction(async (tx) => {
      await tx
        .update(wecomIdBindingCodes)
        .set({ status: "expired" })
        .where(and(eq(wecomIdBindingCodes.userId, input.userId), eq(wecomIdBindingCodes.status, "pending")));
      const rows = await tx
        .insert(wecomIdBindingCodes)
        .values({
          code: input.code,
          userId: input.userId,
          status: "pending",
          expiresAt: input.expiresAt,
          createdAt: input.at,
        })
        .onConflictDoNothing()
        .returning({ id: wecomIdBindingCodes.id });
      return rows.length > 0;
    });
  }

  /**
   * 当前仍未失效的 pending 绑定码（v1.8 读面回填）：同一 user_id 至多一条（部分唯一索引
   * uq_wecom_id_binding_codes_pending），按 id 降序取最新；已用 / 已过期 / 已废止一律不命中（null = 无可回填的码）。
   */
  async findPendingBindingCode(
    userId: string,
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<{ code: string; expiresAt: Date } | null> {
    const rows = await client
      .select({ code: wecomIdBindingCodes.code, expiresAt: wecomIdBindingCodes.expiresAt })
      .from(wecomIdBindingCodes)
      .where(
        and(
          eq(wecomIdBindingCodes.userId, userId),
          eq(wecomIdBindingCodes.status, "pending"),
          gt(wecomIdBindingCodes.expiresAt, at),
        ),
      )
      .orderBy(desc(wecomIdBindingCodes.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 按码取值（任意状态 —— ingest 需区分「不存在」与「已用 / 过期」两类回执，口径 §5）。 */
  async findBindingCode(code: string, client: DbClient = this.database.db): Promise<DmBindingCodeRow | null> {
    const rows = await client
      .select({
        id: wecomIdBindingCodes.id,
        code: wecomIdBindingCodes.code,
        userId: wecomIdBindingCodes.userId,
        status: wecomIdBindingCodes.status,
        expiresAt: wecomIdBindingCodes.expiresAt,
      })
      .from(wecomIdBindingCodes)
      .where(eq(wecomIdBindingCodes.code, code))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 绑定（同一事务 · 口径 §3 第 3 步）：① 先占码（pending 且未过期才可占 —— 并发 / 重复投递只有一方占到）；
   * ② 换绑清旧：同一用户在同一机器人上的其它绑定行去址（保留激活登记，仅注销投递资格）；③ upsert 绑定行
   * （bot_id + wecom_userid 唯一）—— 行已存在时按唯一键改挂到码持有者：**跨用户换绑**（v1.8：发送方企微号
   * 挂在别的库内用户上时，旧持有者随该行改挂而回落未绑定；换绑留痕由调用方同事务写 `audit_logs`）。
   * 返回 false = 码已被占 / 已过期（调用方按「码已失效」回执）。
   */
  async bindWithCode(
    input: { codeId: number; userId: string; botId: string; wecomUserid: string; at: Date },
    client: DbClient = this.database.db,
  ): Promise<boolean> {
    return await client.transaction(async (tx) => {
      const claimed = await tx
        .update(wecomIdBindingCodes)
        .set({ status: "used", usedAt: input.at, usedWecomUserid: input.wecomUserid })
        .where(
          and(
            eq(wecomIdBindingCodes.id, input.codeId),
            eq(wecomIdBindingCodes.status, "pending"),
            gt(wecomIdBindingCodes.expiresAt, input.at),
          ),
        )
        .returning({ id: wecomIdBindingCodes.id });
      if (claimed.length === 0) {
        return false;
      }
      await tx
        .update(wecomAibotDmActivations)
        .set({ userId: null, boundAt: null, updatedAt: input.at })
        .where(
          and(
            eq(wecomAibotDmActivations.botId, input.botId),
            eq(wecomAibotDmActivations.userId, input.userId),
            ne(wecomAibotDmActivations.wecomUserid, input.wecomUserid),
          ),
        );
      await tx
        .insert(wecomAibotDmActivations)
        .values({
          botId: input.botId,
          wecomUserid: input.wecomUserid,
          userId: input.userId,
          firstActivatedAt: input.at,
          lastMessageAt: input.at,
          boundAt: input.at,
          createdAt: input.at,
          updatedAt: input.at,
        })
        .onConflictDoUpdate({
          target: [wecomAibotDmActivations.botId, wecomAibotDmActivations.wecomUserid],
          set: {
            userId: input.userId,
            boundAt: input.at,
            lastMessageAt: input.at,
            updatedAt: input.at,
          },
        });
      return true;
    });
  }

  /** 投递留痕（channel = wecom_aibot；一次尝试一行）。 */
  async insertDelivery(input: NotifyDmDeliveryInsert, client: DbClient = this.database.db): Promise<void> {
    await client.insert(notifyDeliveries).values({
      outboxId: input.outboxId,
      channel: "wecom_aibot",
      target: input.target,
      state: input.state,
      attempts: input.attempts,
      error: input.error,
      sentAt: input.sentAt,
    });
  }
}