import { describe, expect, it } from "vitest";
import {
  ADDRESS_VISIBLE_BEFORE_MIN,
  can,
  type Actor,
} from "./capabilities";

/**
 * ロール×capability の純粋関数テスト（spec 13-3 / 15章 / 7-2）。
 * DB を使う RLS 側の検証は tests/integration/auth-rls.test.ts。
 */

const owner: Actor = { role: "owner" };
const admin: Actor = { role: "admin" };
const reception: Actor = { role: "reception" };
const therapistA: Actor = { role: "therapist", therapistId: "t-a" };
const therapistB: Actor = { role: "therapist", therapistId: "t-b" };

const startAt = new Date("2026-08-29T20:00:00+09:00");
const minutesBefore = (min: number) =>
  new Date(startAt.getTime() - min * 60_000);

describe("顧客住所の閲覧（spec 13-3）", () => {
  const base = {
    kind: "customer_address",
    reservationTherapistId: "t-a",
    reservationStartAt: startAt,
  } as const;

  it("担当セラピストは3時間前から閲覧できる", () => {
    expect(
      can(therapistA, "view_customer_address", {
        ...base,
        now: minutesBefore(ADDRESS_VISIBLE_BEFORE_MIN),
      }),
    ).toBe(true);
  });

  it("担当セラピストでも3時間前より早いと閲覧できない", () => {
    expect(
      can(therapistA, "view_customer_address", {
        ...base,
        now: minutesBefore(ADDRESS_VISIBLE_BEFORE_MIN + 1),
      }),
    ).toBe(false);
  });

  it("他人の予約の住所は直前でも閲覧できない（spec 15章）", () => {
    expect(
      can(therapistB, "view_customer_address", { ...base, now: startAt }),
    ).toBe(false);
  });

  it("therapistId 未設定のセラピストは閲覧できない（fail-closed）", () => {
    expect(
      can({ role: "therapist" }, "view_customer_address", {
        ...base,
        now: startAt,
      }),
    ).toBe(false);
  });

  it("運営（owner/admin/reception）は業務上いつでも閲覧できる（閲覧ログは呼び出し側の義務）", () => {
    for (const actor of [owner, admin, reception]) {
      expect(
        can(actor, "view_customer_address", {
          ...base,
          now: minutesBefore(60 * 24),
        }),
      ).toBe(true);
    }
  });

  it("文脈なしでは常に拒否", () => {
    expect(can(owner, "view_customer_address")).toBe(false);
  });
});

describe("報酬の閲覧（spec 15章）", () => {
  it("セラピストは自分の報酬のみ閲覧できる", () => {
    expect(
      can(therapistA, "view_payout", { kind: "payout", payoutTherapistId: "t-a" }),
    ).toBe(true);
    expect(
      can(therapistA, "view_payout", { kind: "payout", payoutTherapistId: "t-b" }),
    ).toBe(false);
  });

  it("reception は報酬を閲覧できない / owner・admin はできる", () => {
    const ctx = { kind: "payout", payoutTherapistId: "t-a" } as const;
    expect(can(reception, "view_payout", ctx)).toBe(false);
    expect(can(owner, "view_payout", ctx)).toBe(true);
    expect(can(admin, "view_payout", ctx)).toBe(true);
  });
});

describe("枠外予約（spec 7-2 / 8-1: 理由必須）", () => {
  it("運営は理由つきなら枠外予約を入れられる", () => {
    const ctx = { kind: "slot_override", reason: "常連の強い希望" } as const;
    expect(can(owner, "override_slot", ctx)).toBe(true);
    expect(can(admin, "override_slot", ctx)).toBe(true);
    expect(can(reception, "override_slot", ctx)).toBe(true);
  });

  it("理由が空・空白のみなら owner でも拒否", () => {
    expect(can(owner, "override_slot", { kind: "slot_override", reason: "" })).toBe(false);
    expect(can(owner, "override_slot", { kind: "slot_override", reason: "  " })).toBe(false);
  });

  it("therapist は枠外予約を入れられない", () => {
    expect(
      can(therapistA, "override_slot", { kind: "slot_override", reason: "理由" }),
    ).toBe(false);
  });
});

describe("文脈なし capability", () => {
  it("CSV 出力は管理者（owner/admin）のみ（spec 13-3）", () => {
    expect(can(owner, "export_csv")).toBe(true);
    expect(can(admin, "export_csv")).toBe(true);
    expect(can(reception, "export_csv")).toBe(false);
    expect(can(therapistA, "export_csv")).toBe(false);
  });

  it("予約の作成・変更は owner/admin/reception", () => {
    expect(can(reception, "manage_reservations")).toBe(true);
    expect(can(therapistA, "manage_reservations")).toBe(false);
  });

  it("ユーザー管理・CMS・報酬管理・監査ログ閲覧は owner/admin のみ", () => {
    for (const cap of [
      "manage_users",
      "manage_cms",
      "manage_payouts",
      "view_audit_logs",
    ] as const) {
      expect(can(owner, cap)).toBe(true);
      expect(can(admin, cap)).toBe(true);
      expect(can(reception, cap)).toBe(false);
      expect(can(therapistA, cap)).toBe(false);
    }
  });
});
