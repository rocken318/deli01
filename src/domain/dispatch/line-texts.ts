/**
 * 配車の送り/キャッチ LINE テキスト4種（設計 5.7）。純関数・生成のみ（自動送信しない）。
 * 女性向けは電話番号を構造的に含めない（customerPhone は運転手向けだけ）。
 */
export interface DispatchLineInput {
  therapistName: string;
  destination: string;              // ホテル名 or 送り先
  direction?: string | null;        // 方面
  departText?: string | null;       // 出発 HH:MM
  outText?: string | null;          // アウト HH:MM
  roomNumber?: string | null;
  entryNote?: string | null;        // 迎え方
  customerPhone?: string | null;    // 運転手向けのみ
  meetupPlace?: string | null;      // 女性向け集合場所（既定「事務所下」）
}
export interface DispatchLineTexts {
  sendDriver: string; sendWoman: string; catchDriver: string; catchWoman: string;
}

function place(i: DispatchLineInput): string {
  return i.direction ? `${i.destination}（${i.direction}）` : i.destination;
}
function line(parts: (string | null | undefined)[]): string {
  return parts.filter((p) => p != null && p !== "").join("\n");
}

export function buildDispatchLineTexts(i: DispatchLineInput): DispatchLineTexts {
  const meet = i.meetupPlace && i.meetupPlace !== "" ? i.meetupPlace : "事務所下";
  const sendDriver = line([
    "●●送り●●",
    "事務所下に着いたら、女性が降りますのでご連絡ください。",
    "",
    i.departText ? `出発 ${i.departText}` : "出発",
    `女性 ${i.therapistName}`,
    `場所 ${place(i)}`,
    i.roomNumber ? `部屋 ${i.roomNumber}` : null,
    i.entryNote ? `迎え ${i.entryNote}` : null,
    i.customerPhone ? `電話 ${i.customerPhone}` : null,
    "お願いします",
  ]);
  const sendWoman = line([
    `【送り】${i.therapistName}さん`,
    i.departText ? `${i.departText} 出発予定です` : "出発のご連絡です",
    `${meet}までお願いします`,
  ]);
  const catchDriver = line([
    "☆☆キャッチ☆☆",
    i.outText ? `アウト ${i.outText}` : "アウト",
    `女性 ${i.therapistName}`,
    `場所 ${place(i)}`,
    i.roomNumber ? `部屋 ${i.roomNumber}` : null,
    i.customerPhone ? `電話 ${i.customerPhone}` : null,
    "お願いします",
  ]);
  const catchWoman = line([
    `【お迎え】${i.therapistName}さん`,
    i.outText ? `アウト ${i.outText} 頃にお迎えです` : "お迎えのご連絡です",
    `${meet}でお待ちください`,
  ]);
  return { sendDriver, sendWoman, catchDriver, catchWoman };
}
