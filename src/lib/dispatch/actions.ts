'use server';

/**
 * フェーズ13 送信テンプレート・配車テキスト生成 Server Actions（spec 8-3 ★）。
 *
 * lib/ に置く理由: フェーズ14 配車ボードが同アクションを再利用するため。
 * 配車ボードはこのファイルを import し、UI だけを差し替える。
 *
 * 設計上の核（spec 8-3 の緊張の解消）:
 * - 打診用（inquiry）は INQUIRY_FORBIDDEN_KEYS を buildDispatchMessage が構造的に除去。
 * - 確定用（confirmed）は canGenerateDispatch（server 側で再検証）を通した場合のみ生成。
 * - コピー時に dispatch_logs に追記。監査対象（spec 8-3 L795）。
 * - ゲートは Server Action 側で完結。UI の値を信用しない。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import {
  buildDispatchMessage,
  formatDispatchDateTime,
  formatTimeHM,
  formatTravelMode,
  formatYen,
  optionBackYen,
} from '@/domain/dispatch';
import {
  canGenerateDispatch,
  canGenerateInquiry,
} from '@/lib/booking/phone-confirmation';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// 1. getDispatchTemplates
// ---------------------------------------------------------------------------

export interface TemplateInfo {
  name: string;
  body: string;
}

export interface DispatchTemplates {
  inquiry: TemplateInfo;
  confirmed: TemplateInfo;
}

/**
 * message_templates を読み、打診用・確定用を返す。
 * reception も読める（RLS 担保）。
 */
export async function getDispatchTemplates(): Promise<ActionResult<DispatchTemplates>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const sql = getClient();
  const rows = await withUser(sql, session, async (tx) => {
    return tx<{ kind: string; name: string; body: string }[]>`
      select kind::text, name, body
      from message_templates
      where is_active = true
      order by kind asc
    `;
  });

  const inquiry = rows.find((r) => r.kind === 'inquiry');
  const confirmed = rows.find((r) => r.kind === 'confirmed');

  if (!inquiry || !confirmed) {
    return {
      ok: false,
      error:
        'テンプレートが見つかりません。管理者にお問い合わせください（シードデータを確認）',
    };
  }

  return {
    ok: true,
    data: {
      inquiry: { name: inquiry.name, body: inquiry.body },
      confirmed: { name: confirmed.name, body: confirmed.body },
    },
  };
}

// ---------------------------------------------------------------------------
// 2. updateDispatchTemplate
// ---------------------------------------------------------------------------

const updateTemplateSchema = z.object({
  kind: z.enum(['inquiry', 'confirmed']),
  body: z.string().min(1, 'テンプレート本文を入力してください'),
  name: z.string().min(1, '名称を入力してください').optional(),
});

/**
 * テンプレート本文を更新する（owner/admin のみ）。
 * RLS もガードするが、アプリ層でもロールを確認する二重防御。
 */
export async function updateDispatchTemplate(
  kind: 'inquiry' | 'confirmed',
  body: string,
  name?: string,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const actor = toActor(session);
  if (!can(actor, 'manage_cms')) {
    return { ok: false, error: 'テンプレートの編集は owner/admin のみです' };
  }

  const parsed = updateTemplateSchema.safeParse({ kind, body, name });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.errors.map((e) => e.message).join(', '),
    };
  }

  const d = parsed.data;
  const sql = getClient();

  try {
    const updated = await withUser(sql, session, async (tx) => {
      // name は渡されたときのみ更新（coalesce で未指定は既存値を保持）
      const rows = await tx<{ id: string }[]>`
        update message_templates
        set body = ${d.body},
            name = coalesce(${d.name ?? null}, name),
            updated_by = ${session.userId}::uuid
        where kind = ${d.kind}::template_kind
        returning id
      `;
      const row = rows[0];
      if (!row) return null;

      // 監査ログ（spec 8-3 L795 の思想。テンプレは PII 授受の文面を決める CMS 編集で、
      // 他の CMS 系 action と同様に audit_logs へ追記して編集履歴を残す）
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid,
          'update',
          'message_template',
          ${row.id}::uuid,
          ${tx.json({ kind: d.kind, name: d.name ?? null })}
        )
      `;
      return row.id;
    });

    if (!updated) {
      return { ok: false, error: 'テンプレートが見つかりません' };
    }
    return { ok: true };
  } catch (e) {
    // 生 Postgres エラー（制約名・RLS 詳細等）を画面に出さない。サーバ側にのみ残す
    console.error('updateDispatchTemplate failed:', e);
    return { ok: false, error: 'テンプレートの更新に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 3. generateDispatchText
// ---------------------------------------------------------------------------

export interface GenerateDispatchResult {
  text: string;
  /** 確定用生成が可能か（UI のボタン活性化用） */
  canConfirmed: boolean;
}

/**
 * 予約行から DispatchVars を組み、buildDispatchMessage で送信テキストを生成する。
 *
 * ゲート（server 側）:
 * - kind==='confirmed': canGenerateDispatch が false なら拒否
 * - kind==='inquiry': canGenerateInquiry が false なら拒否
 *
 * DispatchVars マッピング:
 * - 移動手段: transport_fee > 0 を「車」として扱う。
 *   根拠: 電話受付 actions.ts が transport_fee を feeBreakdown で算出しており、
 *   car モードでのみ transportFee > 0 になる（fees.ts の設計）。
 *   walk = 0 / car > 0 の二値の写像として transport_fee を利用する。
 * - バック額: オプションバック合計のみ（コース単位バックはフェーズ18以降）。
 *   コメントで暫定であることを明記。
 */
export async function generateDispatchText(
  reservationId: string,
  kind: 'inquiry' | 'confirmed',
): Promise<ActionResult<GenerateDispatchResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsedId = z.string().uuid().safeParse(reservationId);
  if (!parsedId.success) return { ok: false, error: '無効な予約IDです' };

  const sql = getClient();

  try {
    // 予約行 + 関連を1クエリ群で取得
    const reservationRows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string;
        status: string;
        phone_confirmed_at: Date | null;
        start_at: Date;
        depart_at: Date;
        transport_fee: number;
        total_amount: number;
        customer_name: string;
        customer_phone: string;
        customer_note: string | null;
        address_detail: string | null;
        address_label: string | null;
        hotel_name: string | null;
        course_name: string;
        therapist_name: string | null;
        therapist_slug: string;
        area_name: string | null;
      }[]>`
        select
          r.id,
          r.status::text,
          r.phone_confirmed_at,
          r.start_at,
          r.depart_at,
          r.transport_fee,
          r.total_amount,
          c.name    as customer_name,
          c.phone   as customer_phone,
          c.note    as customer_note,
          a.detail  as address_detail,
          a.label   as address_label,
          h.name    as hotel_name,
          co.name   as course_name,
          er.published->>'name' as therapist_name,
          t.slug    as therapist_slug,
          ar.name   as area_name
        from reservations r
        join customers c    on c.id  = r.customer_id
        join addresses a    on a.id  = r.address_id
        join courses co     on co.id = r.course_id
        join therapists t   on t.id  = r.therapist_id
        left join entity_records er
               on er.entity = 'therapist' and er.slug = t.slug
        left join hotels h  on h.id  = r.hotel_id
        left join areas ar  on ar.id = r.area_id
        where r.id = ${parsedId.data}::uuid
        limit 1
      `;
    });

    const reservation = reservationRows[0];
    if (!reservation) {
      return { ok: false, error: '予約が見つかりません' };
    }

    // ゲートチェック（server 側で完結。UI の値は信用しない）
    const reservationForGate = {
      status: reservation.status,
      phone_confirmed_at: reservation.phone_confirmed_at,
    };

    const canConfirmed = canGenerateDispatch(reservationForGate);

    if (kind === 'confirmed' && !canConfirmed) {
      return {
        ok: false,
        error: '電話確認が済むまで確定用（住所入り）は生成できません',
      };
    }

    if (kind === 'inquiry' && !canGenerateInquiry(reservationForGate)) {
      return {
        ok: false,
        error: '予約が確定状態でないため打診テキストを生成できません',
      };
    }

    // オプション名とバック額を取得
    const optionRows = await withUser(sql, session, async (tx) => {
      return tx<{
        option_name: string;
        price_snapshot: number;
        back_type_snapshot: string;
        back_value_snapshot: number;
      }[]>`
        select
          ro.price_snapshot,
          ro.back_type_snapshot::text,
          ro.back_value_snapshot,
          op.name as option_name
        from reservation_options ro
        join options op on op.id = ro.option_id
        where ro.reservation_id = ${parsedId.data}::uuid
      `;
    });

    // テンプレートを取得
    const templateRows = await withUser(sql, session, async (tx) => {
      return tx<{ body: string }[]>`
        select body
        from message_templates
        where kind = ${kind}::template_kind
          and is_active = true
        limit 1
      `;
    });

    const templateBody = templateRows[0]?.body;
    if (!templateBody) {
      return {
        ok: false,
        error: `${kind === 'inquiry' ? '打診用' : '確定用'}テンプレートが見つかりません`,
      };
    }

    // DispatchVars を組み立てる
    const optionNames =
      optionRows.length > 0
        ? optionRows.map((o) => o.option_name).join('、')
        : 'なし';

    // バック額: オプションバック合計のみ（暫定。コース単位バックはフェーズ18以降）
    const totalBackYen = optionRows.reduce((sum, o) => {
      const bt = o.back_type_snapshot as 'fixed' | 'rate';
      return sum + optionBackYen(bt, o.back_value_snapshot, o.price_snapshot);
    }, 0);

    // 場所: ホテルの場合はホテル名 + address_detail を連結
    let placeStr = reservation.address_detail ?? '';
    if (reservation.hotel_name) {
      placeStr = reservation.hotel_name + (reservation.address_detail ? ` ${reservation.address_detail}` : '');
    }

    // 移動手段: transport_fee > 0 → 車（fees.ts の設計: walk=0 / car>0）
    const travelMode: 'walk' | 'car' = reservation.transport_fee > 0 ? 'car' : 'walk';

    const vars = {
      日時: formatDispatchDateTime(reservation.start_at),
      出発目安: formatTimeHM(reservation.depart_at),
      セラピスト: reservation.therapist_name ?? reservation.therapist_slug,
      コース: reservation.course_name,
      オプション: optionNames,
      場所: placeStr,
      部屋番号: reservation.address_label ?? '',
      顧客名: reservation.customer_name,
      電話番号: reservation.customer_phone,
      お好み: reservation.customer_note ?? '',
      合計金額: formatYen(reservation.total_amount),
      バック額: formatYen(totalBackYen),
      移動手段: formatTravelMode(travelMode),
      エリア: reservation.area_name ?? '',
    };

    // inquiry のとき buildDispatchMessage が INQUIRY_FORBIDDEN_KEYS を除去する
    const text = buildDispatchMessage({
      kind,
      template: templateBody,
      vars,
    });

    return { ok: true, data: { text, canConfirmed } };
  } catch (e) {
    // 生 Postgres エラーを画面に出さない（業務上の拒否は上の明示 return で返している）
    console.error('generateDispatchText failed:', e);
    return { ok: false, error: '送信テキストの生成に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 4. recordDispatch
// ---------------------------------------------------------------------------

const recordDispatchSchema = z.object({
  reservationId: z.string().uuid(),
  kind: z.enum(['inquiry', 'confirmed']),
  bodySnapshot: z.string().min(1),
});

/**
 * コピー時に dispatch_logs に追記する。
 * confirmed の場合は canGenerateDispatch を server 側で再検証（UI 信用しない）。
 * dispatch_logs は追記専用（update/delete 不可）。
 */
export async function recordDispatch(
  reservationId: string,
  kind: 'inquiry' | 'confirmed',
  bodySnapshot: string,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = recordDispatchSchema.safeParse({ reservationId, kind, bodySnapshot });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.errors.map((e) => e.message).join(', '),
    };
  }

  const sql = getClient();

  // 業務ルール（not_found / ゲート）は throw せず判別可能な値で返し、明示メッセージを保つ。
  // 生 Postgres 例外だけを catch で汎用文言に落とす（spec 受入 L1128 の拒否文言を守る）。
  type RecordOutcome =
    | { kind: 'ok' }
    | { kind: 'not_found' }
    | { kind: 'gate_confirmed' }
    | { kind: 'gate_inquiry' };

  try {
    const outcome = await withUser<RecordOutcome>(sql, session, async (tx) => {
      // 予約の基本情報を取得（ゲート再検証 + therapist_id 解決）
      const reservationRows = await tx<{
        status: string;
        phone_confirmed_at: Date | null;
        therapist_id: string;
      }[]>`
        select status::text, phone_confirmed_at, therapist_id
        from reservations
        where id = ${parsed.data.reservationId}::uuid
        limit 1
      `;

      const reservation = reservationRows[0];
      if (!reservation) return { kind: 'not_found' };

      // server 側でゲートを再検証（UI 信用しない / spec 受入 L1128）
      if (parsed.data.kind === 'confirmed') {
        if (
          !canGenerateDispatch({
            status: reservation.status,
            phone_confirmed_at: reservation.phone_confirmed_at,
          })
        ) {
          return { kind: 'gate_confirmed' };
        }
      } else if (!canGenerateInquiry({ status: reservation.status })) {
        return { kind: 'gate_inquiry' };
      }

      // dispatch_logs に追記（insert only）
      await tx`
        insert into dispatch_logs (
          reservation_id,
          therapist_id,
          kind,
          body_snapshot,
          created_by
        ) values (
          ${parsed.data.reservationId}::uuid,
          ${reservation.therapist_id}::uuid,
          ${parsed.data.kind}::template_kind,
          ${parsed.data.bodySnapshot},
          ${session.userId}::uuid
        )
      `;
      return { kind: 'ok' };
    });

    switch (outcome.kind) {
      case 'ok':
        return { ok: true };
      case 'not_found':
        return { ok: false, error: '予約が見つかりません' };
      case 'gate_confirmed':
        return { ok: false, error: '電話確認が済むまで確定用は記録できません' };
      case 'gate_inquiry':
        return { ok: false, error: '予約が確定状態でないため打診を記録できません' };
    }
  } catch (e) {
    console.error('recordDispatch failed:', e);
    return { ok: false, error: '送信記録に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 5. listDispatchTargets
// ---------------------------------------------------------------------------

export interface DispatchTargetRow {
  reservationId: string;
  customerName: string;
  therapistName: string;
  startAtISO: string;
  phoneConfirmed: boolean;
  /** dispatch_logs に inquiry が存在するか */
  inquirySent: boolean;
  /** dispatch_logs に confirmed が存在するか */
  confirmedSent: boolean;
}

/**
 * 配車テキスト送信対象の予約一覧（status='confirmed'・start_at 昇順・上限50）。
 * 各行に送信済みフラグを含む。
 */
export async function listDispatchTargets(): Promise<ActionResult<DispatchTargetRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const sql = getClient();

  const rows = await withUser(sql, session, async (tx) => {
    return tx<{
      reservation_id: string;
      customer_name: string;
      therapist_name: string | null;
      therapist_slug: string;
      start_at: Date;
      phone_confirmed_at: Date | null;
      inquiry_sent: boolean;
      confirmed_sent: boolean;
    }[]>`
      select
        r.id as reservation_id,
        c.name as customer_name,
        er.published->>'name' as therapist_name,
        t.slug as therapist_slug,
        r.start_at,
        r.phone_confirmed_at,
        exists(
          select 1 from dispatch_logs dl
          where dl.reservation_id = r.id and dl.kind = 'inquiry'
        ) as inquiry_sent,
        exists(
          select 1 from dispatch_logs dl
          where dl.reservation_id = r.id and dl.kind = 'confirmed'
        ) as confirmed_sent
      from reservations r
      join customers c    on c.id = r.customer_id
      join therapists t   on t.id = r.therapist_id
      left join entity_records er
             on er.entity = 'therapist' and er.slug = t.slug
      where r.status = 'confirmed'
        and r.start_at >= now() - interval '2 hours'
      order by r.start_at asc
      limit 50
    `;
  });

  return {
    ok: true,
    data: rows.map((r) => ({
      reservationId: r.reservation_id,
      customerName: r.customer_name,
      therapistName: r.therapist_name ?? r.therapist_slug,
      startAtISO: r.start_at.toISOString(),
      phoneConfirmed: r.phone_confirmed_at !== null,
      inquirySent: r.inquiry_sent,
      confirmedSent: r.confirmed_sent,
    })),
  };
}
