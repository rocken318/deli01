-- 0027_customer_portal: 顧客マイページ（マジックリンク）。パスワード不要・トークンで本人確認。
--
-- 各顧客に推測困難な portal_token（uuid）を自動付与。公開ページ /c/<token> が
-- security definer 関数でその顧客の要約（ポイント残高・予約履歴・指名した女性）だけを返す。
-- トークンがそのまま認証＝リンクを知らない人は見られない（発注者確定 2026-09-03）。

alter table customers
  add column if not exists portal_token uuid not null default gen_random_uuid();
create unique index if not exists customers_portal_token_uniq on customers (portal_token);

-- 顧客ポータル要約（トークンで本人分のみ）。RLS はバイパスするが where portal_token で厳格スコープ。
create or replace function customer_portal_summary(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with cust as (
    select id, name, coalesce(cached_points, 0) as points
    from customers
    where portal_token = p_token
  ),
  hist as (
    select r.start_at,
           r.status::text as status,
           coalesce(er.published ->> 'name', t.slug) as therapist,
           t.slug as therapist_slug,
           co.name as course
    from reservations r
    join cust on cust.id = r.customer_id
    left join therapists t on t.id = r.therapist_id
    left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
    left join courses co on co.id = r.course_id
    where r.status in ('done', 'confirmed', 'enroute', 'in_service')
    order by r.start_at desc
    limit 30
  )
  select case when exists (select 1 from cust) then jsonb_build_object(
    'name', (select name from cust),
    'points', (select points from cust),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', to_char(start_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD'),
        'therapist', therapist,
        'therapistSlug', therapist_slug,
        'course', course,
        'status', status
      )) from hist), '[]'::jsonb)
  ) else null end;
$$;

revoke all on function customer_portal_summary(uuid) from public;
grant execute on function customer_portal_summary(uuid) to app_runtime;
