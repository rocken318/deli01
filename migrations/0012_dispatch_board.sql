-- 0012_dispatch_board: 配車ボード・セラピストマイページの中核（フェーズ14 /
-- spec 7-1 配車ボード・7-3 セラピスト安全・7-4 マイページ・13-3 権限・受入 L1134）
--
-- ============================================================================
-- 設計ノート
-- ============================================================================
-- 1. RLS 精緻化（booking-holds.md §10「フェーズ14着手前に必須」）
--    フェーズ11 の therapist ポリシーは「担当予約が1件でもあれば（cancelled/noshow
--    含む・何日前でも）customers/addresses を select 可」だった。spec 13-3
--    「担当セラピストにのみ、予約の3時間前から表示」に合わせて
--      - 予約 status in ('confirmed','enroute','in_service','done') に絞る
--        （held/cancelled/noshow の予約は住所閲覧の根拠にならない）
--      - now() >= start_at - interval '180 minutes' の時刻ゲートを足す
--        （src/domain/auth の ADDRESS_VISIBLE_BEFORE_MIN = 180 と同値。
--         可視終了側の上限は設けない = 当日の道順再確認を妨げない / 判断ログ#8）
--
-- 2. 電話番号の列制御（spec 7-3「顧客の電話番号をセラピスト個人端末に残さない」）
--    本アプリは単一 DB ロール app_runtime + GUC(app.current_role) で RLS を効かせる
--    構成のため、**RLS では列を隠せない**（行単位のみ）。列 GRANT も GUC で分岐
--    できない（staff も同じ app_runtime で動く）。そこで
--      - customers への therapist 直接 select ポリシーを**撤去**（default deny）
--      - phone を含まない view `customers_therapist_view` を新設し、therapist は
--        これ経由でのみ顧客情報（name/name_kana/note）を読む
--    view の所有者はマイグレーション実行ユーザー（BYPASSRLS）なので、view 本体の
--    where 句（担当 × status × 180分ゲート）がそのまま防衛線になる（security_barrier
--    で述語の押し下げによる漏えいも防ぐ）。therapist が生 SQL で customers を
--    select しても 0 行、view には phone 列自体が存在しない。
--
-- 3. 到着・退出のワンタップ記録（spec 7-3 L705）
--    enroute_at / arrived_at / service_started_at / done_at を reservations に追加。
--    **exclusion 制約・depart_at/free_at の占有契約は変更しない**。
--    「退出予定を過ぎて退出記録が無ければアラート」は end_at と done_at の比較で
--    アプリ側（src/domain/dispatch-board の isExitOverdue）が判定する。
--
-- 4. therapist の自己予約 update（booking-holds.md §9）
--    RLS は「自分の担当行」という行スコープのみを担保する。**列の制限と遷移の
--    前進のみ**は RLS では書けないため、BEFORE UPDATE トリガ
--    reservations_therapist_guard が担保する（allow-list 方式: status・タップ
--    タイムスタンプ・version(+1のみ)・updated_at 以外の列変更を拒否。将来
--    列が増えても自動的に保護される）。Server Action 側の純関数 canTransition が
--    一次検証、トリガは最終防衛線（アプリのチェックだけに頼らない）。
--
-- 5. 住所閲覧の監査（spec 13-3「閲覧は監査ログ」）は select では書けないため、
--    セラピスト向け住所取得 Server Action（src/lib/dispatch-board）が
--    audit_logs (action='view', entity='address') に追記する（0001 の想定形）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 前提確認: reservation_status enum が必要な値を全部持つこと（0008 で作成済み。
-- 欠けていたら設計前提が崩れているので、黙って進まず fail loud）
-- ---------------------------------------------------------------------------
do $$
declare
  missing text;
begin
  select string_agg(v, ', ') into missing
  from unnest(array['held','confirmed','enroute','in_service','done','noshow','cancelled']) as v
  where v not in (
    select e.enumlabel from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'reservation_status'
  );
  if missing is not null then
    raise exception 'reservation_status に必要な値が欠けています: %', missing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 到着・退出等のワンタップ記録列（spec 7-3。命名は phone_confirmed_at に倣う）
--   enroute_at         = 「移動中」に進めた時刻（confirmed → enroute）
--   arrived_at         = 到着記録（施術開始時に未記録なら同時刻で補完）
--   service_started_at = 「施術中」に進めた時刻（enroute → in_service）
--   done_at            = 退出記録 = 「完了」に進めた時刻（in_service → done）
-- ---------------------------------------------------------------------------
alter table reservations
  add column if not exists enroute_at         timestamptz,
  add column if not exists arrived_at         timestamptz,
  add column if not exists service_started_at timestamptz,
  add column if not exists done_at            timestamptz;

-- ---------------------------------------------------------------------------
-- RLS 精緻化 1/4: customers
-- therapist の直接 select を撤去（電話番号の列制御のため。閲覧は下の
-- customers_therapist_view 経由のみ）。staff ポリシーは 0008 のまま。
-- ---------------------------------------------------------------------------
drop policy if exists customers_therapist_select on customers;

-- ---------------------------------------------------------------------------
-- RLS 精緻化 2/4: addresses（spec 13-3 ★）
-- 担当予約 × status 絞り × 開始180分前ゲート。
-- ---------------------------------------------------------------------------
drop policy if exists addresses_therapist_select on addresses;
create policy addresses_therapist_select on addresses
  for select using (
    app_current_role() = 'therapist'
    and exists (
      select 1
      from reservations r
      join app_users u on u.id = app_current_user_id()
      where r.address_id = addresses.id
        and r.therapist_id = u.therapist_id
        and r.status in ('confirmed', 'enroute', 'in_service', 'done')
        and now() >= r.start_at - interval '180 minutes'
    )
  );

-- ---------------------------------------------------------------------------
-- RLS 精緻化 3/4: reservations
-- select: 自分の担当 × status 絞り（held は Web の仮押さえ途中で見せる意味がなく、
--         cancelled/noshow はマイページ「今日の予定」に出さない。時刻ゲートは
--         **設けない**＝明日以降の予定・過去の実績もマイページに出す / spec 7-4）
-- update: 自分の担当のみ（行スコープ）。列・遷移の制限は下のトリガが担保。
-- ---------------------------------------------------------------------------
drop policy if exists reservations_therapist_select on reservations;
create policy reservations_therapist_select on reservations
  for select using (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
    and status in ('confirmed', 'enroute', 'in_service', 'done')
  );

drop policy if exists reservations_therapist_update on reservations;
create policy reservations_therapist_update on reservations
  for update
  using (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
    -- 進められるのは完了前の自分の予約だけ（done/cancelled 等は不可）
    and status in ('confirmed', 'enroute', 'in_service')
  )
  with check (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
    and status in ('confirmed', 'enroute', 'in_service', 'done')
  );

-- ---------------------------------------------------------------------------
-- RLS 精緻化 4/4: reservation_options（予約に準じて status を絞る。
-- 内容はコース/オプションのスナップショットで住所ほど機微ではないため
-- 時刻ゲートは設けない）
-- ---------------------------------------------------------------------------
drop policy if exists reservation_options_therapist_select on reservation_options;
create policy reservation_options_therapist_select on reservation_options
  for select using (
    app_current_role() = 'therapist'
    and exists (
      select 1
      from reservations r
      join app_users u on u.id = app_current_user_id()
      where r.id = reservation_options.reservation_id
        and r.therapist_id = u.therapist_id
        and r.status in ('confirmed', 'enroute', 'in_service', 'done')
    )
  );

-- ---------------------------------------------------------------------------
-- therapist の自己 update ガード（列 allow-list + 前進遷移 + set-once）
-- RLS は行スコープしか担保できないため、列と遷移は BEFORE UPDATE トリガで守る。
-- staff（owner/admin/reception）と特権経路（GUC なし）は素通し。
-- ---------------------------------------------------------------------------
create or replace function reservations_therapist_guard() returns trigger
language plpgsql as $$
declare
  -- therapist が変更してよい列（これ以外の差分は拒否。将来の追加列も自動で保護）
  allowed constant text[] := array[
    'status', 'enroute_at', 'arrived_at', 'service_started_at', 'done_at',
    'version', 'updated_at'
  ];
begin
  if app_current_role() is distinct from 'therapist' then
    return new;
  end if;

  if (to_jsonb(old) - allowed) is distinct from (to_jsonb(new) - allowed) then
    raise exception 'therapist はステータスとタップ記録以外を更新できません'
      using errcode = '42501';
  end if;

  -- version は楽観ロックの +1 のみ（巻き戻し・飛び越しは不可）
  if new.version is distinct from old.version and new.version <> old.version + 1 then
    raise exception 'version は +1 でのみ更新できます' using errcode = '42501';
  end if;

  -- 遷移は confirmed→enroute→in_service→done の隣接前進のみ（後退・スキップ不可。
  -- 一次検証は src/domain/dispatch-board の canTransition。ここは最終防衛線）
  if new.status is distinct from old.status and not (
       (old.status = 'confirmed'  and new.status = 'enroute')
    or (old.status = 'enroute'    and new.status = 'in_service')
    or (old.status = 'in_service' and new.status = 'done')
  ) then
    raise exception 'ステータスは前へのみ進められます（% → % は不可）',
      old.status, new.status using errcode = '42501';
  end if;

  -- タップ記録は set-once（null → 値 のみ。記録の書き換え・取り消しは不可）
  if (new.enroute_at         is distinct from old.enroute_at         and old.enroute_at         is not null)
  or (new.arrived_at         is distinct from old.arrived_at         and old.arrived_at         is not null)
  or (new.service_started_at is distinct from old.service_started_at and old.service_started_at is not null)
  or (new.done_at            is distinct from old.done_at            and old.done_at            is not null) then
    raise exception 'タップ記録は一度だけ記録できます' using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists reservations_therapist_guard on reservations;
create trigger reservations_therapist_guard
  before update on reservations
  for each row execute function reservations_therapist_guard();

-- ---------------------------------------------------------------------------
-- customers_therapist_view: セラピスト向け顧客ビュー（phone を持たない列制御 /
-- spec 7-3）。所有者は特権ユーザーなので view の where がそのままゲートになる。
-- 行スコープは addresses_therapist_select と同一条件（担当 × status × 180分）。
-- 発信は「アプリ内発信/転送番号」前提（v1 は UI ボタン止まり / spec 16章）。
-- ---------------------------------------------------------------------------
drop view if exists customers_therapist_view;
create view customers_therapist_view
with (security_barrier = true) as
  select c.id, c.name, c.name_kana, c.note
  from customers c
  where app_current_role() = 'therapist'
    and exists (
      select 1
      from reservations r
      join app_users u on u.id = app_current_user_id()
      where r.customer_id = c.id
        and r.therapist_id = u.therapist_id
        and r.status in ('confirmed', 'enroute', 'in_service', 'done')
        and now() >= r.start_at - interval '180 minutes'
    );

grant select on customers_therapist_view to app_runtime;
-- **読み取り専用にする（重要）**: 単純ビューは PostgreSQL の自動更新可能ビューになり、
-- 0001 の default privileges が app_runtime へ INSERT/UPDATE/DELETE を配ってしまう。
-- ビュー所有者(postgres)権限で base table に届く＝RLS をバイパスして therapist が
-- customers.name 等を書き換えられる（reviewer 実測）。DML を明示的に剥がす（spec 13-3）。
revoke insert, update, delete on customers_therapist_view from app_runtime;
