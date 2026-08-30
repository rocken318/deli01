import "server-only";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

/**
 * 引き継ぎメモの中核（フェーズ16 / spec 9章 L810-814）。
 *
 * 行スコープは RLS（migrations/0014）が正:
 * - staff: 全件
 * - therapist: 「その顧客の次回以降の自分の担当予約（confirmed/enroute/in_service）が
 *   あるとき」だけ当該顧客のメモを select できる。書けるのは自分名義で、実際に
 *   担当した（in_service/done）予約の顧客のみ。
 * - 顧客本人・無関係のセラピスト: 0行（受入 L1123）
 *
 * ここでは RLS の結果をそのまま返し、アプリ側で追加のフィルタをしない
 * （二重実装のずれを避ける。テストは RLS を直接検証する）。
 */

export interface HandoverNote {
  id: string;
  customerId: string;
  reservationId: string | null;
  therapistId: string;
  therapistName: string | null;
  body: string;
  createdAt: Date;
}

export type AddHandoverOutcome =
  | { kind: "ok"; noteId: string }
  | { kind: "reservation_not_found" }
  | { kind: "not_completed" }
  | { kind: "forbidden" };

/**
 * 施術完了時にセラピストが一言残す（spec L811）。
 * therapist セッション専用（staff の代筆は authorship がずれるため v1 では不可）。
 * 対象予約は RLS の select スコープ内（自分の担当）かつ in_service/done であること。
 *
 * 人格・容姿への言及禁止の注意書きは UI 側の責務（spec L814）。ここでは
 * 空文字（空白のみ）を拒否する（DB の handover_notes_body_check と二重）。
 */
export async function addHandoverNoteCore(
  sql: Sql,
  session: Session,
  params: { reservationId: string; body: string },
): Promise<AddHandoverOutcome> {
  if (session.role !== "therapist" || !session.therapistId) {
    return { kind: "forbidden" };
  }
  const body = params.body.trim();
  if (body.length === 0) return { kind: "forbidden" };

  return withUser(sql, session, async (tx) => {
    // RLS: reservations_therapist_select が自分の担当（confirmed..done）に絞る
    const rows = await tx<
      { id: string; customer_id: string | null; status: string }[]
    >`
      select id, customer_id, status
      from reservations
      where id = ${params.reservationId}::uuid
      limit 1
    `;
    const r = rows[0];
    if (!r || r.customer_id === null) return { kind: "reservation_not_found" } as const;
    if (r.status !== "in_service" && r.status !== "done") {
      return { kind: "not_completed" } as const;
    }

    // returning は SELECT ポリシーの評価を受ける（本人にも「次回予約があるまで」
    // 見せない厳格設計のため、直後の自分の insert 行すら不可視になり得る）。
    // id はアプリ側で生成し、returning を使わない。
    const noteId = randomUUID();
    await tx`
      insert into handover_notes (id, customer_id, reservation_id, therapist_id, body)
      values (
        ${noteId}::uuid,
        ${r.customer_id}::uuid,
        ${r.id}::uuid,
        ${session.therapistId ?? ""}::uuid,
        ${body}
      )
    `;
    return { kind: "ok", noteId } as const;
  });
}

/**
 * 顧客の過去メモ一覧（新しい順）。
 * - therapist セッション: RLS により「次回以降の自分の担当予約がある」ときだけ
 *   行が返る（無関係なら 0 行）。次回予約の準備画面・マイページ
 *   （フェーズ14 getTherapistTimelineCore への統合は admin-ui 後続）から呼ぶ。
 * - staff セッション: 全件（電話受付の引き継ぎ確認用）。
 */
export async function getHandoverNotesCore(
  sql: Sql,
  session: Session,
  params: { customerId: string },
): Promise<HandoverNote[]> {
  return withUser(sql, session, async (tx) => {
    const rows = await tx<
      {
        id: string;
        customer_id: string;
        reservation_id: string | null;
        therapist_id: string;
        therapist_name: string | null;
        body: string;
        created_at: Date;
      }[]
    >`
      select
        n.id,
        n.customer_id,
        n.reservation_id,
        n.therapist_id,
        coalesce(er.published->>'name', t.slug) as therapist_name,
        n.body,
        n.created_at
      from handover_notes n
      left join therapists t on t.id = n.therapist_id
      left join entity_records er
             on er.entity = 'therapist' and er.slug = t.slug
      where n.customer_id = ${params.customerId}::uuid
      order by n.created_at desc, n.id desc
    `;
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      reservationId: r.reservation_id,
      therapistId: r.therapist_id,
      therapistName: r.therapist_name,
      body: r.body,
      createdAt: r.created_at,
    }));
  });
}
