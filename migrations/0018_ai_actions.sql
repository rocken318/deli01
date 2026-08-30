-- 0018_ai_actions: フェーズ21 CMS内AIアシスタント（AI操作履歴）
--
-- 設計の骨子:
--   ai_actions = AI 操作の全履歴（追記専用）。
--     - AI の出力は必ず "提案(proposed)" として記録される
--     - 承認(approved) → draft にのみ反映。published は絶対に触らない（受入 L1124）
--     - 構造変更(structure_change) は差分プレビュー→承認を経てから draft に適用（受入 L1125）
--     - 全操作が記録される（受入 L1126）
--     - status 更新（承認/却下）は owner/admin のみ
--   RLS: staff 閲覧・insert。status 更新は owner/admin のみ（manage_cms 相当）
--   追記専用: delete は grant しない（AI が何を出力したかの事実を消させない）

-- ---------------------------------------------------------------------------
-- 0. enum 定義（冪等）
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'ai_action_type') then
    create type ai_action_type as enum (
      'generate',              -- 下書き生成（プロフィール/キャッチ/お知らせ/FAQ/SEO）
      'rewrite',               -- リライト・トーン調整
      'banned_word_suggest',   -- 禁止語検出＋言い換え提案
      'terminology_suggest',   -- 用語辞書の表記ゆれ統一案
      'structure_change'       -- 構造変更提案（差分プレビュー→承認必須 / 受入 L1125）
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'ai_action_status') then
    create type ai_action_status as enum (
      'proposed',   -- AI 出力あり・未審査（初期状態）
      'approved',   -- owner/admin が承認 → draft にのみ反映済み
      'rejected',   -- owner/admin が却下（何も適用しない）
      'failed'      -- AI 呼び出し失敗（ANTHROPIC_API_KEY 未設定を含む）
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. ai_actions テーブル（追記専用）
-- ---------------------------------------------------------------------------
create table if not exists ai_actions (
  id            bigint generated always as identity primary key,
  -- 操作種別
  action_type   ai_action_type not null,
  -- 対象 entity/slug 等（nullable: 全体提案の場合は null）
  entity        text,
  -- 依頼内容（プロンプト/対象テキスト/種別など / 不変）
  request       jsonb not null,
  -- AI 出力（提案 / 不変）。failed の場合は error を含む
  output        jsonb,
  -- 審査状態（初期 proposed）
  status        ai_action_status not null default 'proposed',
  -- 依頼者
  created_by    uuid references app_users (id) on delete set null,
  -- 審査者（承認/却下した owner/admin）
  reviewed_by   uuid references app_users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. インデックス
-- ---------------------------------------------------------------------------
create index if not exists ai_actions_status_idx      on ai_actions (status);
create index if not exists ai_actions_created_at_idx  on ai_actions (created_at desc);
create index if not exists ai_actions_created_by_idx  on ai_actions (created_by);

-- ---------------------------------------------------------------------------
-- 3. updated_at 自動更新トリガ
-- ---------------------------------------------------------------------------
create or replace function ai_actions_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists ai_actions_updated_at on ai_actions;
create trigger ai_actions_updated_at
  before update on ai_actions
  for each row execute function ai_actions_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. RLS 有効化・強制
-- ---------------------------------------------------------------------------
alter table ai_actions enable row level security;
alter table ai_actions force row level security;

-- ---------------------------------------------------------------------------
-- 5. RLS ポリシー
-- ---------------------------------------------------------------------------

-- 5-a. staff（owner/admin/reception）は ai_actions を閲覧できる
drop policy if exists ai_actions_select on ai_actions;
create policy ai_actions_select on ai_actions
  for select
  using (
    current_setting('app.current_role', true) in ('owner', 'admin', 'reception')
  );

-- 5-b. staff は insert できる（AI を呼ぶ = staff の操作）
drop policy if exists ai_actions_insert on ai_actions;
create policy ai_actions_insert on ai_actions
  for insert
  with check (
    current_setting('app.current_role', true) in ('owner', 'admin', 'reception')
  );

-- 5-c. status/reviewed_by の更新は owner/admin のみ（承認・却下）
--       request/output/action_type/created_by は不変（update 対象を制限）
drop policy if exists ai_actions_update on ai_actions;
create policy ai_actions_update on ai_actions
  for update
  using (
    current_setting('app.current_role', true) in ('owner', 'admin')
  )
  with check (
    current_setting('app.current_role', true) in ('owner', 'admin')
  );

-- 5-d. delete は誰にも許可しない（事実の消去を禁止）
drop policy if exists ai_actions_delete on ai_actions;
-- delete ポリシーなし = 全員 deny

-- ---------------------------------------------------------------------------
-- 6. app_runtime へ grant/revoke
-- ---------------------------------------------------------------------------
grant select, insert on ai_actions to app_runtime;
grant update (status, reviewed_by, updated_at) on ai_actions to app_runtime;
-- delete は grant しない

-- identity sequence は nextval 相当として自動
grant usage on sequence ai_actions_id_seq to app_runtime;
