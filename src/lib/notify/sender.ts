import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";

/**
 * 通知の送信（フェーズ20 / v1後(a) メール配線）。
 *
 * 送信の実体をこの1関数に切り出す（spec 16章の buildDispatchMessage と同じ思想:
 * 送る仕組みが決まったらここだけを差し替える）。呼び出し側（reminders.ts /
 * waitlist.ts / weekly.ts）は 'sent'|'failed'|'skipped' を受けて
 * notifications.status を進める。
 *
 * 挙動:
 *   - SMTP 未設定（SMTP_URL / EMAIL_FROM のいずれか無し = ローカル/CI/未提供）:
 *     従来どおりスタブとして 'sent' を返す（アウトボックスは進む・ビルド/テスト不変）。
 *   - 設定済み: channel==='email' かつ recipient が有効メールアドレスのときだけ
 *     nodemailer で実送信（成功='sent' / 失敗='failed'）。
 *     recipient が電話番号など非メール（v1 の顧客リマインドは電話番号）は 'skipped'
 *     ＝誤送信しない。channel==='line'（LINE Messaging API は v1 スコープ外）も 'skipped'。
 *
 * 顧客宛メールの実配信は customers にメール列が無いため未対応（別タスク: メール収集）。
 * 現状で実際に届くのはメールアドレス宛（例: site_settings.ops_email の週次レポート）のみ。
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

/** 誤送信防止用の緩いメール判定（RFC 完全準拠でなくてよい） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let _transporter: Transporter | undefined;
function getTransporter(url: string): Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport(url);
  }
  return _transporter;
}

export async function sendNotification(
  n: SendableNotification,
): Promise<SendOutcome> {
  const smtpUrl = env.smtpUrl;
  const from = env.emailFrom;

  // 未設定（ローカル/CI/未提供）: 従来どおりスタブ 'sent'（アウトボックスは進む）
  if (!smtpUrl || !from) return "sent";

  // LINE は v1 スコープ外
  if (n.channel !== "email") return "skipped";
  // 宛先がメールでない（顧客リマインドの電話番号等）は誤送信しない
  if (!EMAIL_RE.test(n.recipient)) return "skipped";

  try {
    await getTransporter(smtpUrl).sendMail({
      from,
      to: n.recipient,
      subject: n.subject,
      text: n.body,
    });
    return "sent";
  } catch {
    // 生エラーは残さない（呼び出し側が last_error に汎用文言を記録）
    return "failed";
  }
}
