/**
 * 電話確認ゲート（フェーズ12 / spec 8-1）。
 *
 * - 配車テキスト（確定用）生成には phone_confirmed_at が必須
 * - 打診（inquiry）は電話確認前でも可
 * - 電話注文は保存時に自動で confirmed にする
 */

export interface ReservationForConfirmation {
  phone_confirmed_at: Date | null;
  status: string;
}

/**
 * 配車テキスト（住所・電話番号入り確定用）を生成してよいか。
 * spec 8-3: 確定用は電話確認済みの予約のみ。
 * @returns false if phone_confirmed_at is null, or if status is not 'confirmed'
 */
export function canGenerateDispatch(reservation: ReservationForConfirmation): boolean {
  if (reservation.status !== 'confirmed') return false;
  if (reservation.phone_confirmed_at === null) return false;
  return true;
}

/**
 * 打診テキスト（個人情報なし）を生成してよいか。
 * spec 8-3: 打診はエリア・時間・コース・バック額のみ。電話確認前でも可。
 */
export function canGenerateInquiry(reservation: { status: string }): boolean {
  return reservation.status === 'confirmed';
}
