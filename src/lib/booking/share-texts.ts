'use server';

/**
 * 予約後 LINE 貼り付け用テキスト生成（spec 8-3 の「buildDispatchMessage を切り出して備える」方針）。
 *
 * セラピスト向け: 打診ルール準拠で電話番号を含めない
 *   - 根拠: spec 8-3「打診用は住所と電話番号を含まない」。この「セラピストにLINE」ボタンは
 *     予約直後の速報共有（まだ "inquiry" フェーズ相当）として同じ方針を適用する。
 *     確定後は既存 dispatch/DispatchClient の「確定をコピー」で電話番号入りを生成できる。
 * ドライバー向け: 配車に必要な最小限（出発・行先・部屋・IN・電話）を含める
 *   - 根拠: ドライバーは現地に赴くため電話番号は業務上必須。dispatch の `confirmed` と同じ
 *     扱い（現地送迎担当 = 宛先が決まっている段階でのみ使う）。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { formatInTimeZone } from 'date-fns-tz';

const TZ = 'Asia/Tokyo';

export interface BookingShareTexts {
  therapist: string;
  driver: string;
}

export interface ShareTextsResult {
  ok: boolean;
  data?: BookingShareTexts;
  error?: string;
}

function fmtDateTime(at: Date): string {
  // "M/D(曜) HH:MM" 形式（formatDispatchDateTime と同じ表示。date-fns-tz で JST に正規化）
  const md = formatInTimeZone(at, TZ, 'M/d');
  const hm = formatInTimeZone(at, TZ, 'HH:mm');
  // isoDay: 月=1…日=7 → 7%7=0 で日曜先頭の固定表
  const isoDay = Number(formatInTimeZone(at, TZ, 'i'));
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;
  const weekday = WEEKDAYS[isoDay % 7] ?? '';
  return `${md}(${weekday}) ${hm}`;
}

function fmtTimeHM(at: Date): string {
  return formatInTimeZone(at, TZ, 'HH:mm');
}

/**
 * 予約1件からセラピスト向け・ドライバー向けの LINE 貼り付け用テキストを返す。
 * can(manage_reservations) 必須。クライアントから DB に直接触らない。
 */
export async function getBookingShareTexts(
  reservationId: string,
): Promise<ShareTextsResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const actor = toActor(session);
  if (!can(actor, 'manage_reservations')) {
    return { ok: false, error: 'この操作には権限が必要です' };
  }

  const parsedId = z.string().uuid().safeParse(reservationId);
  if (!parsedId.success) return { ok: false, error: '無効な予約IDです' };

  const sql = getClient();

  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        start_at: Date;
        depart_at: Date;
        course_name: string;
        course_duration_min: number;
        therapist_name: string | null;
        therapist_slug: string;
        nomination_fee: number;
        customer_phone: string | null;
        customer_note: string | null;
        hotel_name: string | null;
        area_name: string | null;
        address_label: string | null;
        address_detail: string | null;
        room_number: string | null;
        option_names: string | null;
      }[]>`
        select
          r.start_at,
          r.depart_at,
          co.name                              as course_name,
          co.duration_min                      as course_duration_min,
          er.published->>'name'                as therapist_name,
          t.slug                               as therapist_slug,
          r.nomination_fee,
          c.phone                              as customer_phone,
          c.note                               as customer_note,
          h.name                               as hotel_name,
          ar.name                              as area_name,
          a.label                              as address_label,
          a.detail                             as address_detail,
          r.room_number,
          (
            select string_agg(o.name, '・' order by o.sort_order)
            from reservation_options ro
            join options o on o.id = ro.option_id
            where ro.reservation_id = r.id
          )                                    as option_names
        from reservations r
        join courses co    on co.id = r.course_id
        join therapists t  on t.id  = r.therapist_id
        left join entity_records er
               on er.entity = 'therapist' and er.slug = t.slug
        left join customers c on c.id  = r.customer_id
        left join hotels h    on h.id  = r.hotel_id
        left join areas ar    on ar.id = r.area_id
        left join addresses a on a.id  = r.address_id
        where r.id = ${parsedId.data}::uuid
        limit 1
      `;
    });

    const row = rows[0];
    if (!row) return { ok: false, error: '予約が見つかりません' };

    // 場所ラベル（ホテル名 > エリア名 > 住所ラベル > "不明"）
    const place = row.hotel_name ?? row.area_name ?? row.address_label ?? '不明';

    // 部屋番号（0025 → "0025号室"、なければ省略）
    const roomStr = row.room_number ? ` ${row.room_number}号室` : '';

    // 指名有無（nomination_fee > 0 → 指名あり）
    const nominated = row.nomination_fee > 0 ? '指名あり' : '';

    // オプション
    const optStr = row.option_names ? `＋${row.option_names}` : '';

    // 備考
    const noteStr = row.customer_note ? `\n備考: ${row.customer_note}` : '';

    // --- セラピスト向け（電話番号なし） ---
    // "セラピスト名 様" の宛名ではなく本文のみ（LINEに貼る用途）
    const therapistText = [
      `【予約確定】${fmtDateTime(row.start_at)}`,
      `${row.therapist_name ?? row.therapist_slug} 担当`,
      `コース: ${row.course_name}${row.course_duration_min}分${optStr}`,
      nominated ? `指名: ${nominated}` : null,
      `場所: ${place}${roomStr}`,
      noteStr || null,
    ]
      .filter((line) => line !== null && line !== '')
      .join('\n');

    // --- ドライバー向け（電話番号あり） ---
    const driverLines: string[] = [
      `【配車】${fmtTimeHM(row.depart_at)} 出発`,
      `行先: ${place}${roomStr}`,
      `IN: ${fmtTimeHM(row.start_at)}`,
      `担当: ${row.therapist_name ?? row.therapist_slug}`,
    ];
    if (row.customer_phone) {
      driverLines.push(`TEL: ${row.customer_phone}`);
    }
    const driverText = driverLines.join('\n');

    return {
      ok: true,
      data: { therapist: therapistText, driver: driverText },
    };
  } catch (e) {
    console.error('getBookingShareTexts failed:', e);
    return { ok: false, error: 'テキストの生成に失敗しました' };
  }
}
