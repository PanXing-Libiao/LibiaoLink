-- LibiaoLink · 0049 用户外观偏好存量统一（所有人 = 适中 + 无水印）+ 默认值改档（Push 313 · px 线；
--   user_preferences 载体 / identity 模块属 wmj 线，跨线代改，请 wmj / lan 复核）
-- 口径来源：业务口径 2026-10-14「把系统当前所有人的背景改成适中 无水印 这个设成默认的」：
--   ① 存量回填（本迁移）：既有 user_preferences 行一律 prefs.backgroundTier = 'medium'（适中）+
--      prefs.cardWatermark = false（无水印）—— 此前显式选过其它档 / 开过水印的账号也按本次口径统一覆盖；
--   ② 新默认（代码侧读侧收敛，不建行）：无行账号 / 缺省 / 坏值一律 medium + false ——
--      server/src/modules/identity/user-preference.service.ts（backgroundTierOf / cardWatermarkOf）+
--      契约 shared/src/modules/users.ts 描述 + 前端 frontend/src/backgroundTier.ts 同批（Push 313）。
-- 变更（只加不改 · 数据回填不动结构）：单条 update 以 jsonb 合并回填两键（键已存在则覆盖）—— 无新键、无 DDL。
-- 幂等：再跑一次命中 0 行（两键值已等于目标值）。
-- 回滚（如需）：两键删回缺省（旧默认 simple / true 由旧构建读侧收敛）——
--   update user_preferences set prefs = prefs - 'backgroundTier' - 'cardWatermark', updated_at = now();
-- 验证（执行后自查）：select prefs ->> 'backgroundTier', prefs -> 'cardWatermark', count(*)
--   from user_preferences group by 1, 2;  -- 应只剩 medium / false 一行

update user_preferences
   set prefs = prefs || '{"backgroundTier": "medium", "cardWatermark": false}'::jsonb,
       updated_at = now()
 where prefs ->> 'backgroundTier' is distinct from 'medium'
    or prefs -> 'cardWatermark' is distinct from 'false'::jsonb;
