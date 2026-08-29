/**
 * ロール × capability の対応表と判定関数（フェーズ1）。
 * DB にも Next.js にも依存しない純粋関数。RLS（migrations/0001_auth.sql）と
 * 同じルールをアプリ層でも表現する二重防御の「アプリ側」。
 *
 * 根拠:
 * - spec 13-3: 顧客住所は担当セラピストにのみ、予約の3時間前から表示。
 *   閲覧は監査ログに残す。CSV 出力は管理者のみ
 * - spec 15章: セラピストは他人の顧客住所と他人の報酬を取得できない
 * - spec 7-2 / 8-1: 運営権限では枠外予約も入れられる。理由の入力必須・監査ログに残す
 */

export const ROLES = ["owner", "admin", "reception", "therapist"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** 判定対象の操作。文脈（ctx）が要るものと要らないものがある */
export type Capability =
  // 文脈なし（ロールだけで決まる）
  | "manage_users" // app_users の作成・無効化・ロール変更
  | "manage_cms" // field_definitions / site_settings / terminology / pages の編集
  | "manage_reservations" // 予約の作成・変更（電話受付を含む）
  | "manage_payouts" // 報酬の締め・支払・レート編集
  | "view_audit_logs" // 監査ログの閲覧
  | "export_csv" // CSV 出力（spec 13-3: 管理者のみ）
  // 文脈つき（ctx 必須）
  | "view_customer_address" // 顧客住所の閲覧（spec 13-3）
  | "view_payout" // 報酬の閲覧（spec 15: 他人の報酬は不可）
  | "override_slot"; // 空き枠エンジンの枠外に予約を入れる（spec 7-2: 理由必須）

/** 判定の主体。Session（src/lib/auth）から role / therapistId を写して渡す */
export interface Actor {
  role: Role;
  /** role === 'therapist' のときのみ意味を持つ */
  therapistId?: string;
}

/** 顧客住所は施術開始の何分前から担当セラピストに見せるか（spec 13-3: 3時間） */
export const ADDRESS_VISIBLE_BEFORE_MIN = 180;

/** 顧客住所の閲覧文脈（spec 13-3） */
export interface CustomerAddressContext {
  kind: "customer_address";
  /** その住所が紐づく予約の担当セラピスト */
  reservationTherapistId: string;
  /** 施術開始時刻（reservations.start_at） */
  reservationStartAt: Date;
  /** 現在時刻（呼び出し側で now を注入。純粋関数に Date.now を埋め込まない） */
  now: Date;
}

/** 報酬の閲覧文脈（spec 15） */
export interface PayoutContext {
  kind: "payout";
  /** 報酬行の帰属セラピスト */
  payoutTherapistId: string;
}

/** 枠外予約の文脈（spec 7-2 / 8-1: 理由の入力を必須にする） */
export interface SlotOverrideContext {
  kind: "slot_override";
  /** 無理を承知で入れる理由。空・空白のみは不可 */
  reason: string;
}

export type CapabilityContext =
  | CustomerAddressContext
  | PayoutContext
  | SlotOverrideContext;

/** 文脈なし capability のロール対応表 */
const STATIC_CAPABILITIES: Record<
  Exclude<Capability, "view_customer_address" | "view_payout" | "override_slot">,
  readonly Role[]
> = {
  manage_users: ["owner", "admin"],
  manage_cms: ["owner", "admin"],
  manage_reservations: ["owner", "admin", "reception"],
  manage_payouts: ["owner", "admin"],
  view_audit_logs: ["owner", "admin"],
  export_csv: ["owner", "admin"], // spec 13-3: CSV 出力は管理者のみ
};

/**
 * 顧客住所を閲覧できるか（spec 13-3）。
 * - owner/admin/reception: 業務上必要（受付が住所を入力・確認する）ので常に可。
 *   ただし「可＝無記録」ではない。閲覧のたびに audit_logs
 *   (action='view', entity='address') へ記録するのは呼び出し側の義務
 * - therapist: 自分が担当する予約で、施術開始の3時間前以降のみ。
 *   終了側の上限は spec に規定がないため設けない（当日の再確認・道順確認を妨げない）
 */
export function canViewCustomerAddress(
  actor: Actor,
  ctx: Omit<CustomerAddressContext, "kind">,
): boolean {
  if (actor.role === "owner" || actor.role === "admin" || actor.role === "reception") {
    return true;
  }
  // therapist
  if (!actor.therapistId) return false;
  if (actor.therapistId !== ctx.reservationTherapistId) return false;
  const visibleFromMs =
    ctx.reservationStartAt.getTime() - ADDRESS_VISIBLE_BEFORE_MIN * 60_000;
  return ctx.now.getTime() >= visibleFromMs;
}

/**
 * 報酬を閲覧できるか（spec 15: 他人の報酬は不可）。
 * reception は報酬に一切触れない（受付業務に不要な情報は渡さない）。
 */
export function canViewPayout(
  actor: Actor,
  ctx: Omit<PayoutContext, "kind">,
): boolean {
  if (actor.role === "owner" || actor.role === "admin") return true;
  if (actor.role === "reception") return false;
  return actor.therapistId !== undefined && actor.therapistId === ctx.payoutTherapistId;
}

/**
 * 枠外予約を入れられるか（spec 7-2 / 8-1）。
 * 運営側（owner/admin/reception）のみ。理由が空なら誰であっても不可
 * （「理由の入力を必須にし、監査ログに残す」）。
 * 判断ログ: 8-1 が電話受付の要件として枠外予約を挙げているため reception を含める。
 */
export function canOverrideSlot(
  actor: Actor,
  ctx: Omit<SlotOverrideContext, "kind">,
): boolean {
  if (ctx.reason.trim().length === 0) return false;
  return actor.role === "owner" || actor.role === "admin" || actor.role === "reception";
}

/**
 * 統一入口。文脈つき capability は ctx 必須（型では強制しきれないため、
 * ctx 不足・kind 不一致は false = 拒否側に倒す）。
 */
export function can(
  actor: Actor,
  capability: Capability,
  ctx?: CapabilityContext,
): boolean {
  switch (capability) {
    case "view_customer_address":
      return ctx?.kind === "customer_address"
        ? canViewCustomerAddress(actor, ctx)
        : false;
    case "view_payout":
      return ctx?.kind === "payout" ? canViewPayout(actor, ctx) : false;
    case "override_slot":
      return ctx?.kind === "slot_override" ? canOverrideSlot(actor, ctx) : false;
    default:
      return STATIC_CAPABILITIES[capability].includes(actor.role);
  }
}
