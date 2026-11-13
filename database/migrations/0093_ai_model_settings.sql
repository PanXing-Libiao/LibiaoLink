-- 模型服务配置：密钥只保存服务端加密结果；当前启用模型为全系统单例。
create table ai_model_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_url text not null,
  api_key_encrypted text,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users(id),
  updated_by uuid references users(id)
);

create table ai_model_selection (
  id boolean primary key default true,
  provider_id uuid not null references ai_model_providers(id) on delete cascade,
  model_id text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id),
  constraint ck_ai_model_selection_single check (id)
);

grant select, insert, update, delete on ai_model_providers to libiaolink_api;
grant select, insert, update, delete on ai_model_selection to libiaolink_api;
