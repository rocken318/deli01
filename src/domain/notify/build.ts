/**
 * 通知生成の純粋関数（フェーズ20）。DB にも Next.js にも依存しない。
 *
 * - buildNotification: テンプレ（subject/body）× 変数 → 通知文面。
 *   {{変数}} 補間は dispatch の interpolate を再利用（未定義変数は空文字・落ちない）。
 * - reminderSchedule: 予約 → 前日 / 2時間前 の2件のリマインド予定
 *   （受入 L1131「前日と2時間前に1回ずつだけ」）。
 * - dedupe_key 規約 = '{kind}:{参照ID}'。DB の unique(dedupe_key) が
 *   重複送信の最終防衛線（migrations/0017）。
 */

import { interpolate } from "../dispatch/message";

/** DB enum notification_kind の写像 */
export type NotificationKind =
  | "reminder_prev_day"
  | "reminder_2h"
  | "waitlist_open"
  | "weekly_report"
  | "flash_deal";

export type ReminderKind = "reminder_prev_day" | "reminder_2h";

/** リマインドの送信時刻オフセット（施術開始からの遡り・分） */
export const REMINDER_OFFSETS_MIN: Readonly<Record<ReminderKind, number>> = {
  reminder_prev_day: 24 * 60, // 前日 = start_at − 24h
  reminder_2h: 120,           // 当日 = start_at − 2h
};

/**
 * 重複送信防止キー（受入 L1131）。DB の unique(dedupe_key) と対になる。
 * 例: 'reminder_prev_day:2f3a...-uuid'
 */
export function notificationDedupeKey(kind: NotificationKind, refId: string): string {
  return `${kind}:${refId}`;
}

export interface ReminderScheduleEntry {
  kind: ReminderKind;
  /** 送るべき時刻（= start_at − オフセット） */
  scheduledFor: Date;
  dedupeKey: string;
}

/**
 * 予約1件のリマインド予定（前日・2時間前の2件）を返す。
 * Date の加減算はエポックミリ秒で行う（文字列で日時計算しない）。
 */
export function reminderSchedule(input: {
  reservationId: string;
  startAt: Date;
}): readonly ReminderScheduleEntry[] {
  return (Object.keys(REMINDER_OFFSETS_MIN) as ReminderKind[]).map((kind) => ({
    kind,
    scheduledFor: new Date(
      input.startAt.getTime() - REMINDER_OFFSETS_MIN[kind] * 60_000,
    ),
    dedupeKey: notificationDedupeKey(kind, input.reservationId),
  }));
}

export interface BuiltNotification {
  subject: string;
  body: string;
}

/**
 * テンプレ × 変数 → 通知文面。
 * 変数はすべて整形済み文字列で渡す（例: 日時 "9/3(水) 13:00"、金額 "¥12,000"）。
 * 未定義の {{変数}} は空文字になり、絶対に throw しない（dispatch と同じ保証）。
 *
 * リマインドテンプレの想定変数（0017 の既定テンプレ / CMS で編集可）:
 *   {{顧客名}} {{日時}} {{コース}} {{セラピスト}}
 * waitlist_open: {{顧客名}} {{日付}} {{エリア}} / weekly_report: {{週}} {{本文}}
 */
export function buildNotification(input: {
  subjectTemplate: string;
  bodyTemplate: string;
  vars: Record<string, string>;
}): BuiltNotification {
  return {
    subject: interpolate(input.subjectTemplate, input.vars),
    body: interpolate(input.bodyTemplate, input.vars),
  };
}
