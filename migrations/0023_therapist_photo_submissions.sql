-- 0023_therapist_photo_submissions: キャスト本人の写真提出→管理が承認/却下（承認制・下書き止まり / 機能H）
--
-- 背景: media は owner/admin のみ write（0003）・therapist は entity_records も直接更新不可（0002）。
-- そこでキャスト投稿は専用キューに積み、承認時だけ media 化して下書きギャラリーに載せる。
-- ＝media を汚さず・本人は自分の提出のみ・承認まで非公開（deli01 の「下書き止まり/承認制」ethos）。

do $$ begin
  if not exists (select 1 from pg_type where typname = 'photo_submission_status') then
    create type photo_submission_status as enum ('pending', 'approved', 'rejected');
  end if;
end $$;

create table if not exists therapist_photo_submissions (
  id            uuid primary key default gen_random_uuid(),
  therapist_id  uuid not null references therapists (id) on delete cascade,
  url           text not null,                 -- Vercel Blob の公開URL（提出時点）
  storage_path  text not null default '',
  mime          text not null default 'image/webp',
  width         integer,
  height        integer,
  consent_flag  boolean not null default false, -- 本人の掲載同意（提出時に必須）
  cast_note     text,                            -- 本人メモ（任意）
  status        photo_submission_status not null default 'pending',
  media_id      uuid references media (id) on delete set null, -- 承認時に作成した media
  review_note   text,                            -- 却下理由など
  reviewed_by   uuid references app_users (id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists tps_therapist_status_idx
  on therapist_photo_submissions (therapist_id, status);
create index if not exists tps_pending_idx
  on therapist_photo_submissions (created_at) where status = 'pending';

alter table therapist_photo_submissions enable row level security;
alter table therapist_photo_submissions force row level security;

-- select: owner/admin は全件、therapist は自分の分のみ
drop policy if exists tps_select on therapist_photo_submissions;
create policy tps_select on therapist_photo_submissions
  for select using (
    app_current_role() in ('owner', 'admin')
    or (
      app_current_role() = 'therapist'
      and therapist_id = (
        select therapist_id from app_users
        where id = app_current_user_id() and therapist_id is not null
        limit 1
      )
    )
  );

-- insert: therapist は自分の therapist_id・pending のみ（他人 therapist_id は with check で拒否）。owner/admin も可。
drop policy if exists tps_insert on therapist_photo_submissions;
create policy tps_insert on therapist_photo_submissions
  for insert with check (
    app_current_role() in ('owner', 'admin')
    or (
      app_current_role() = 'therapist'
      and status = 'pending'
      and therapist_id = (
        select therapist_id from app_users
        where id = app_current_user_id() and therapist_id is not null
        limit 1
      )
    )
  );

-- update（承認/却下）: owner/admin のみ。提出後は本人変更不可（監査・改ざん防止）。
drop policy if exists tps_update_admin on therapist_photo_submissions;
create policy tps_update_admin on therapist_photo_submissions
  for update using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- delete: owner/admin のみ。
drop policy if exists tps_delete_admin on therapist_photo_submissions;
create policy tps_delete_admin on therapist_photo_submissions
  for delete using (app_current_role() in ('owner', 'admin'));

grant select, insert, update, delete on therapist_photo_submissions to app_runtime;
