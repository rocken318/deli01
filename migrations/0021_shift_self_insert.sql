-- 0021_shift_self_insert: キャスト本人による出勤予定の登録を許す（フェーズB / spec 3-3）
--
-- 0007 は shifts に self_select / self_update（当日欠勤ワンタップ）を持つが self insert が無い。
-- shift_areas は therapist=select のみ。本人が自分の出勤を登録＋対応エリアを付与できるよう
-- self insert / self delete を足す。他人 therapist_id は with check / using で拒否される。
-- grant は 0007 で付与済み（app_runtime に shifts / shift_areas 全操作）。

-- shifts: 本人の行のみ insert 可
drop policy if exists shifts_self_insert on shifts;
create policy shifts_self_insert on shifts
  for insert with check (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
  );

-- shift_areas: 自分の shift の行のみ insert 可
drop policy if exists shift_areas_self_insert on shift_areas;
create policy shift_areas_self_insert on shift_areas
  for insert with check (
    app_current_role() = 'therapist'
    and exists (
      select 1
      from app_users u
      join therapists t on t.id = u.therapist_id
      join shifts s on s.therapist_id = t.id
      where u.id = app_current_user_id()
        and s.id = shift_areas.shift_id
    )
  );

-- shift_areas: 自分の shift の行のみ delete 可（エリア全置換のため）
drop policy if exists shift_areas_self_delete on shift_areas;
create policy shift_areas_self_delete on shift_areas
  for delete using (
    app_current_role() = 'therapist'
    and exists (
      select 1
      from app_users u
      join therapists t on t.id = u.therapist_id
      join shifts s on s.therapist_id = t.id
      where u.id = app_current_user_id()
        and s.id = shift_areas.shift_id
    )
  );
