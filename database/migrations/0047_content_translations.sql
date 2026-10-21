-- LibiaoLink · 0047 内容译文库（§6.16 ㉕ · Push 301 · px）
-- 口径来源：前端功能需求.md §6.16 ㉕（业务口径 2026-10-13「现在点击切换由于项目数量多 翻译不过来会有很大延迟
--   所以我希望当因为手打内容为中文 并且保存的时候 后台自动翻译 并且写入数据库 下次切换翻译的时候直接调用即可」）；
--   契约 shared/src/modules/translate.ts（Push 301 落地）。
-- 用途：手打中文内容的英译缓存 —— 保存链路后台机翻写入（服务端 TranslateService.warmup）、
--   英文界面读库直出（单条 /translate 库优先；批量 /translate/batch 只读查库）。
-- 键口径：(source_lang, target_lang, source_hash) 唯一；source_hash = sha256(source_text)。
--   source_text 存**原文**（术语保护 / 回换 / 规整在服务端做，见 server/src/modules/translate/translate.text.ts；
--   前端与保存链路预热发来的 q 一律原文）—— translated_text 存回换术语后的最终英文。
--   engine = 产出译文的引擎标识（当前 hy-mt-1.5-1.8b；换引擎后可据此批量重翻）。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 生效。
-- 回滚（如需）：
--   drop table if exists content_translations;

create table content_translations (
  id bigserial primary key,
  source_lang text not null default 'zh',
  target_lang text not null,
  source_hash text not null,
  source_text text not null,
  translated_text text not null,
  engine text not null default 'hy-mt-1.5-1.8b',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_content_translations_key unique (source_lang, target_lang, source_hash)
);

create index ix_content_translations_updated on content_translations (updated_at desc);
