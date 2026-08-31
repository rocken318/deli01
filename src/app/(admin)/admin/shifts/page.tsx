/**
 * /admin/shifts — 出勤設定（フェーズ8 / spec 3-3・12-2）。
 *
 * セラピスト×日付で出勤予定を追加・更新する最小画面:
 * - 出勤時間（日跨ぎは終了を翌日として扱う）
 * - 待機開始/終了場所（自宅・最寄り駅・事務所 / spec 3-3）
 * - その日に対応できるエリア（全域とは限らない / spec 3-3）
 * - 1日の最大施術本数
 * - 当日欠勤ワンタップ（本日休み / spec 3-3）
 *
 * 保存した瞬間に公開の出勤表（/schedule）へ反映される（force-dynamic 読取）。
 * 月カレンダー・繰り返しパターンの一括生成は後続（README 判断ログ #17）。
 */

import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { APP_TIME_ZONE, addDaysISO, localDateISO, parseDateISO } from "@/domain/availability";
import {
  deleteShiftAction,
  getShiftBoard,
  saveShiftAction,
  setShiftDayOffAction,
  type ShiftBoard,
  type ShiftBoardTherapist,
} from "@/lib/cms/shift-actions";

export const metadata = { title: "出勤設定" };
export const dynamic = "force-dynamic";

function hhmm(at: Date): string {
  return formatInTimeZone(at, APP_TIME_ZONE, "HH:mm");
}

// ---------------------------------------------------------------------------
// セラピスト1行（既存 shift の編集 or 新規追加フォーム）
// ---------------------------------------------------------------------------

function TherapistShiftRow({
  board,
  therapist,
}: {
  board: ShiftBoard;
  therapist: ShiftBoardTherapist;
}) {
  const shift = therapist.shift;
  const displayName = therapist.name || therapist.slug;

  return (
    <section
      className="border border-adm-border bg-adm-surface p-4"
      style={{ borderRadius: "4px" }}
      aria-label={displayName}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-adm-text">
          {displayName}
          <span className="ml-2 font-normal text-adm-text/50">{therapist.slug}</span>
        </h2>
        <div className="flex items-center gap-2">
          {shift && shift.isDayOff && (
            <span
              className="border border-adm-danger/30 bg-adm-danger/10 px-2 py-0.5 text-xs font-medium text-adm-danger"
              style={{ borderRadius: "4px" }}
            >
              本日休み
            </span>
          )}
          {shift && (
            <>
              {/* 当日欠勤ワンタップ（spec 3-3） */}
              <form action={setShiftDayOffAction}>
                <input type="hidden" name="shiftId" value={shift.id} />
                <input type="hidden" name="isDayOff" value={shift.isDayOff ? "0" : "1"} />
                <button
                  type="submit"
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    shift.isDayOff
                      ? "border border-adm-border text-adm-text hover:border-adm-primary hover:text-adm-primary"
                      : "bg-adm-danger text-white hover:opacity-90"
                  }`}
                  style={{ borderRadius: "4px" }}
                >
                  {shift.isDayOff ? "休みを取り消す" : "本日休みにする"}
                </button>
              </form>
              <form action={deleteShiftAction}>
                <input type="hidden" name="shiftId" value={shift.id} />
                <button
                  type="submit"
                  className="border border-adm-border px-3 py-1 text-xs text-adm-text/60 transition-colors hover:border-adm-danger hover:text-adm-danger"
                  style={{ borderRadius: "4px" }}
                >
                  予定を削除
                </button>
              </form>
            </>
          )}
        </div>
      </div>

      <form action={saveShiftAction} className="space-y-3">
        <input type="hidden" name="therapistId" value={therapist.id} />
        <input type="hidden" name="workDate" value={board.date} />

        <div className="flex flex-wrap items-end gap-4">
          <label className="block text-xs text-adm-text/70">
            開始
            <input
              type="time"
              name="start"
              required
              defaultValue={shift ? hhmm(shift.startAt) : "10:00"}
              className="mt-1 block border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text"
              style={{ borderRadius: "4px" }}
            />
          </label>
          <label className="block text-xs text-adm-text/70">
            終了（開始以前なら翌日扱い）
            <input
              type="time"
              name="end"
              required
              defaultValue={shift ? hhmm(shift.endAt) : "19:00"}
              className="mt-1 block border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text"
              style={{ borderRadius: "4px" }}
            />
          </label>
          <label className="block text-xs text-adm-text/70">
            待機開始場所
            <select
              name="baseStartId"
              defaultValue={shift?.baseStartId ?? ""}
              className="mt-1 block border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text"
              style={{ borderRadius: "4px" }}
            >
              <option value="">未設定</option>
              {board.bases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-adm-text/70">
            待機終了場所
            <select
              name="baseEndId"
              defaultValue={shift?.baseEndId ?? ""}
              className="mt-1 block border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text"
              style={{ borderRadius: "4px" }}
            >
              <option value="">未設定</option>
              {board.bases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-adm-text/70">
            上限本数（空欄 = 上限なし）
            <input
              type="number"
              name="maxBookings"
              min={1}
              defaultValue={shift?.maxBookings ?? ""}
              className="mt-1 block w-28 border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text tabular-nums"
              style={{ borderRadius: "4px" }}
            />
          </label>
        </div>

        <fieldset>
          <legend className="text-xs text-adm-text/70">
            対応エリア（その日に対応できるエリア。全域とは限らない）
            <Link
              href="/admin/areas"
              className="ml-2 text-adm-primary underline hover:no-underline"
            >
              エリアを追加・編集
            </Link>
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {board.areas.map((a) => (
              <label key={a.id} className="flex items-center gap-1.5 text-sm text-adm-text">
                <input
                  type="checkbox"
                  name="areaIds"
                  value={a.id}
                  defaultChecked={shift?.areaIds.includes(a.id) ?? false}
                  className="accent-[#3F7A6B]"
                />
                {a.name}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-end gap-4">
          <label className="block flex-1 text-xs text-adm-text/70">
            メモ
            <input
              type="text"
              name="note"
              defaultValue={shift?.note ?? ""}
              className="mt-1 block w-full border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text"
              style={{ borderRadius: "4px" }}
            />
          </label>
          <button
            type="submit"
            className="bg-adm-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
            style={{ borderRadius: "4px" }}
          >
            {shift ? "この日の予定を更新" : "この日の予定を追加"}
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ページ
// ---------------------------------------------------------------------------

export default async function AdminShiftsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const date = parseDateISO(params.date) ?? localDateISO(new Date());

  let board: ShiftBoard;
  try {
    board = await getShiftBoard(date);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return (
      <div
        role="alert"
        className="border border-adm-danger p-4 text-sm text-adm-danger"
        style={{ borderRadius: "4px" }}
      >
        <p className="font-medium">出勤設定の読み込みに失敗しました</p>
        <p className="mt-1 text-xs">{msg}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-adm-text">出勤設定</h1>
        <div className="flex items-center gap-2">
          <Link
            href={`/admin/shifts?date=${addDaysISO(date, -1)}`}
            className="border border-adm-border px-3 py-1.5 text-sm text-adm-text hover:border-adm-primary hover:text-adm-primary"
            style={{ borderRadius: "4px" }}
          >
            前日
          </Link>
          <form action="/admin/shifts" className="flex items-center gap-2">
            <input
              type="date"
              name="date"
              defaultValue={date}
              className="border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text"
              style={{ borderRadius: "4px" }}
            />
            <button
              type="submit"
              className="border border-adm-border px-3 py-1.5 text-sm text-adm-text hover:border-adm-primary hover:text-adm-primary"
              style={{ borderRadius: "4px" }}
            >
              表示
            </button>
          </form>
          <Link
            href={`/admin/shifts?date=${addDaysISO(date, 1)}`}
            className="border border-adm-border px-3 py-1.5 text-sm text-adm-text hover:border-adm-primary hover:text-adm-primary"
            style={{ borderRadius: "4px" }}
          >
            翌日
          </Link>
        </div>
      </div>

      <p className="text-sm text-adm-text/60">
        {date} の出勤予定。保存した瞬間に公開の
        <Link href={`/schedule?date=${date}`} className="mx-1 text-adm-primary underline">
          出勤表
        </Link>
        へ反映されます（キャッシュ60秒以内 / spec 3-3）。
      </p>

      {board.therapists.length === 0 ? (
        <div className="py-16 text-center text-sm text-adm-text/60">
          <p>稼働中のセラピストがいません。</p>
          <p className="mt-2">
            <Link href="/admin/therapists" className="text-adm-primary underline hover:no-underline">
              セラピスト管理
            </Link>
            から登録してください。
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {board.therapists.map((t) => (
            <TherapistShiftRow key={t.id} board={board} therapist={t} />
          ))}
        </div>
      )}
    </div>
  );
}
