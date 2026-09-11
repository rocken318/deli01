'use server';

/**
 * バック単価表 Server Actions（コース/オプション/指名の固定バック単価を payout_rates から読む）。
 * calc_type='fixed', therapist_id IS NULL, rank_id IS NULL の「デフォルト単価」を対象とする。
 * 権限: manage_cms（閲覧のみ）。保存は既存の upsertPayoutRate（owner/admin のみ）を使う。
 */

import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface BackPriceCourse {
  id: string;
  name: string;
  durationMin: number;
  price: number;
  /** 現行のデフォルト固定バック単価（円）。未設定なら null */
  backYen: number | null;
}

export interface BackPriceOption {
  id: string;
  name: string;
  price: number;
  durationMin: number;
  /** 現行のデフォルト固定バック単価（円）。未設定なら null */
  backYen: number | null;
}

export interface BackPriceTargets {
  courses: BackPriceCourse[];
  options: BackPriceOption[];
  /** 指名バック単価（円）。未設定なら null */
  nominationBackYen: number | null;
}

/**
 * コース・オプション・指名の現行デフォルトバック単価一覧を返す。
 *
 * 「現行」の定義:
 *   - calc_type = 'fixed'
 *   - therapist_id IS NULL かつ rank_id IS NULL
 *   - effective_from <= CURRENT_DATE
 *   - effective_to IS NULL または effective_to > CURRENT_DATE
 *   - 上記に複数行あれば effective_from が最新のものを採用
 */
export async function listBackPriceTargets(): Promise<ActionResult<BackPriceTargets>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) {
    return { ok: false, error: '権限がありません' };
  }

  try {
    const sql = getClient();

    // コース一覧（is_active のみ）
    const courseRows = await sql<{
      id: string;
      name: string;
      duration_min: number;
      price: number;
    }[]>`
      select id, name, duration_min, price
      from courses
      where is_active = true
      order by sort_order, created_at
    `;

    // オプション一覧（is_active のみ）
    const optionRows = await sql<{
      id: string;
      name: string;
      price: number;
      duration_min: number;
    }[]>`
      select id, name, price, duration_min
      from options
      where is_active = true
      order by sort_order, created_at
    `;

    // 現行デフォルト固定レート（課金対象型ごとに最新1件）を一括取得
    // distinct on (target_type, target_id) で最新の effective_from を取る
    const rateRows = await sql<{
      target_type: string;
      target_id: string | null;
      value: number;
    }[]>`
      select distinct on (target_type, target_id)
        target_type,
        target_id::text,
        value
      from payout_rates
      where therapist_id is null
        and rank_id is null
        and calc_type = 'fixed'
        and target_type in ('course', 'option', 'nomination')
        and effective_from <= current_date
        and (effective_to is null or effective_to > current_date)
      order by target_type, target_id, effective_from desc
    `;

    // target_type + target_id をキーにしたマップ
    const rateMap = new Map<string, number>();
    for (const r of rateRows) {
      const key = `${r.target_type}:${r.target_id ?? 'null'}`;
      rateMap.set(key, r.value);
    }

    const courses: BackPriceCourse[] = courseRows.map((c) => ({
      id: c.id,
      name: c.name,
      durationMin: c.duration_min,
      price: c.price,
      backYen: rateMap.get(`course:${c.id}`) ?? null,
    }));

    const options: BackPriceOption[] = optionRows.map((o) => ({
      id: o.id,
      name: o.name,
      price: o.price,
      durationMin: o.duration_min,
      backYen: rateMap.get(`option:${o.id}`) ?? null,
    }));

    const nominationBackYen = rateMap.get('nomination:null') ?? null;

    return {
      ok: true,
      data: { courses, options, nominationBackYen },
    };
  } catch (e) {
    console.error('listBackPriceTargets failed:', e);
    return { ok: false, error: 'バック単価の取得に失敗しました' };
  }
}
