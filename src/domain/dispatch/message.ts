/**
 * セラピストへの送信テキスト生成（フェーズ13 / spec 8-3 ★）。
 *
 * DB にも Next.js にも依存しない純粋関数。テンプレートは CMS
 * （message_templates）から呼び出し側が渡し、差し込み値も呼び出し側が
 * 整形済みの文字列で渡す（整形ヘルパは ./format）。
 *
 * 設計上の核（spec 8-3 の緊張の解消）:
 * - 打診用（inquiry）は住所・電話番号など個人情報を**構造的に**出さない。
 *   テンプレ本文に {{場所}} 等が混入していても buildDispatchMessage が
 *   vars から除去してから補間するため、出力に現れない（受入 L1108）。
 * - 未定義の変数では絶対に落ちない。空文字に置換する（受入 L1109）。
 * - 電話確認ゲート（phone_confirmed_at 必須 / 受入 L1128）は
 *   src/lib/booking/phone-confirmation.ts の canGenerateDispatch /
 *   canGenerateInquiry を Server Action 側で通す。ここはゲート通過後の前提。
 * - 将来の LINE Messaging API 自動送信に備え、生成は本モジュールに独立
 *   （spec 8-3・16章「buildDispatchMessage を切り出して備える」）。
 */

/** テンプレート種別（DB enum template_kind の写像） */
export type TemplateKind = "inquiry" | "confirmed";

/**
 * 差し込み変数の全キー（spec 8-3 L785 の13個 + {{エリア}}）。
 *
 * {{エリア}} は spec L785 の変数リストには無いが、打診用の必須内容
 * （「エリア・時間・コース・バック額」/ spec 8-3 L787）を満たすために追加した
 * **非個人情報**のキー（エリア名。{{場所}}=住所とは別物で打診に出してよい）。
 * 追加の判断は README 判断ログに記載。順序は spec の13個を先頭に保つ。
 */
export const DISPATCH_VAR_KEYS = [
  "日時",
  "出発目安",
  "セラピスト",
  "コース",
  "オプション",
  "場所",
  "部屋番号",
  "顧客名",
  "電話番号",
  "お好み",
  "合計金額",
  "バック額",
  "移動手段",
  "エリア",
] as const;

export type DispatchVarKey = (typeof DISPATCH_VAR_KEYS)[number];

/**
 * 差し込み変数。すべて整形済みの文字列で渡す（整形は ./format のヘルパ）。
 * - 日時: 施術開始（例 "9/3(水) 13:00"）
 * - 出発目安: depart_at（例 "12:35"）
 * - 合計金額 / バック額: 円の整数を formatYen した文字列（例 "¥12,000"）
 */
export type DispatchVars = Record<DispatchVarKey, string>;

/**
 * 打診（inquiry）に出してはならない個人情報キー（spec 8-3:
 * 「打診用：エリア・時間・コース・バック額のみ。住所と電話番号を含まない」）。
 */
export const INQUIRY_FORBIDDEN_KEYS: readonly DispatchVarKey[] = [
  "場所",
  "部屋番号",
  "顧客名",
  "電話番号",
  "お好み",
];

/**
 * {{トークン}} 補間。トークン内の前後空白を許容する（{{ 日時 }} も一致）。
 * vars に無いキーは空文字に置換し、**絶対に throw しない**（受入 L1109）。
 * 置換後に残るトークンは存在しない（全トークンが一度で解決される）。
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\{\{\s*([^{}]*?)\s*\}\}/g,
    (_match, key: string) => vars[key] ?? "",
  );
}

/**
 * 送信テキストを生成する（spec 8-3 ★）。
 *
 * kind === 'inquiry' のときは INQUIRY_FORBIDDEN_KEYS を vars から必ず除去して
 * から補間する。テンプレ本文（CMS で編集可能）に {{場所}} や {{電話番号}} が
 * 混入していても、対応する値が存在しないため空文字になる = 個人情報が
 * 出力に出ないことを関数レベルで保証する（受入 L1108）。
 * confirmed は全キー許可（住所・部屋番号・顧客名・お好みを含む出発直前用）。
 */
export function buildDispatchMessage(input: {
  kind: TemplateKind;
  template: string;
  vars: Partial<DispatchVars>;
}): string {
  const sanitized: Record<string, string> = {};
  for (const key of DISPATCH_VAR_KEYS) {
    const value = input.vars[key];
    if (value === undefined) continue;
    if (input.kind === "inquiry" && INQUIRY_FORBIDDEN_KEYS.includes(key)) {
      continue; // 打診: 個人情報キーは補間表から落とす → トークンは空文字化
    }
    sanitized[key] = value;
  }
  return interpolate(input.template, sanitized);
}
