/**
 * セラピスト向け連絡テキスト生成（純関数）。
 * 電話番号は含めない（セラピスト向け / spec 7-3）。
 * 未設定値は行ごと省略（落ちない）。
 */

export interface TherapistNoticeInput {
  therapistName: string;
  startText: string;
  courseName: string;
  courseDurationMin: number;
  /** ホテル名 or エリア名 */
  destination: string;
  roomNumber?: string | null;
  entryNote?: string | null;
  optionNames?: string[];
  totalAmount: number;
}

function line(parts: (string | null | undefined)[]): string {
  return parts.filter((p) => p != null && p !== '').join('\n');
}

/**
 * セラピストへコピペで送る連絡文を生成する。
 * 電話番号を含まない。roomNumber/entryNote/optionNames が未設定 or 空の場合はその行を省略。
 */
export function buildTherapistNotice(input: TherapistNoticeInput): string {
  const {
    therapistName,
    startText,
    courseName,
    courseDurationMin,
    destination,
    roomNumber,
    entryNote,
    optionNames,
    totalAmount,
  } = input;

  const opLine =
    optionNames && optionNames.length > 0
      ? `OP ${optionNames.join(' / ')}`
      : null;

  return line([
    `【ご案内】${therapistName} さん`,
    `${startText} ${courseName} ${courseDurationMin}分`,
    `場所 ${destination}`,
    roomNumber ? `部屋 ${roomNumber}` : null,
    entryNote ? `備考 ${entryNote}` : null,
    opLine,
    `合計 ¥${totalAmount.toLocaleString('ja-JP')}`,
  ]);
}
