import "server-only";

/**
 * 通知の送信スタブ（フェーズ20 / 発注者判断で実メール配信は行わない）。
 *
 * 送信の実体をこの1関数に切り出す（spec 16章の buildDispatchMessage と同じ思想:
 * 送る仕組みが決まったらここだけを差し替える）。
 *
 * TODO(② メール配線): メールプロバイダ（SMTP / SES / Resend 等）の資格情報が
 * 発注者から提供されたら、ここに nodemailer 等の実送信を差す。
 *   - channel === 'email': recipient がメールアドレスの場合のみ送信。
 *     v1 の顧客はメールを持たない（customers に email 列が無い）ため、
 *     メール収集の導線（予約フォーム / マイページ）の追加と合わせて配線する
 *   - channel === 'line': LINE Messaging API は v1 スコープ外（spec 16章）
 *   - 失敗時は 'failed' を返し、呼び出し側が notifications.status='failed' +
 *     last_error を記録してリトライ判断する
 *
 * 現状（スタブ）: 実送信せず 'sent' を返す。呼び出し側（reminders.ts 等）が
 * notifications.status を 'sent' に進め、sent_at を刻む。アウトボックス
 * （notifications テーブル）が「何をいつ送るべきだったか」の正であり、
 * 実配信が繋がった時点から後続分が実際に届き始める。
 */

export interface SendableNotification {
  /** notifications.id（bigint。postgres.js からは文字列で来る） */
  id: string;
  channel: "email" | "line";
  recipient: string;
  subject: string;
  body: string;
}

export type SendOutcome = "sent" | "failed" | "skipped";

export async function sendNotification(
  n: SendableNotification,
): Promise<SendOutcome> {
  // ---- ② メール配線ポイント（ここを実装に差し替える） ----------------------
  // 例: await transporter.sendMail({ to: n.recipient, subject: n.subject, text: n.body });
  // -------------------------------------------------------------------------
  void n;
  return "sent";
}
