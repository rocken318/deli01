'use server';

import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { listAnnaiBoardCore } from '@/lib/annai/queries';
import { buildBoard } from '@/domain/annai';
import type { ActionResult } from '@/lib/booking/extension-actions';

export interface AnnaiMiniItem {
  therapistId: string;
  slug: string;
  name: string;
  kind: 'now' | 'from' | 'off' | 'done';
  fromISO: string | null;
  untilISO: string | null;
  gapMin: number | null;
  busyNow: boolean;
  tooShort: boolean;
}

export async function getAnnaiMini(): Promise<ActionResult<AnnaiMiniItem[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  const actor = toActor(session);
  if (!can(actor, 'manage_reservations')) return { ok: false, error: '権限がありません' };

  const sql = getClient();
  const nowMs = Date.now();

  try {
    const boardRows = await withUser(sql, session, (tx) => listAnnaiBoardCore(tx, nowMs));
    const { active } = buildBoard(boardRows, nowMs);

    const data: AnnaiMiniItem[] = active.map((r) => {
      const w = r.window;
      return {
        therapistId: r.therapistId,
        slug: r.slug,
        name: r.name,
        kind: w.kind,
        fromISO: w.fromMs !== null ? new Date(w.fromMs).toISOString() : null,
        untilISO: w.untilMs !== null ? new Date(w.untilMs).toISOString() : null,
        gapMin: w.gapMin,
        busyNow: w.busyNow,
        tooShort: w.tooShort,
      };
    });

    return { ok: true, data };
  } catch (e) {
    console.error('getAnnaiMini failed:', e);
    return { ok: false, error: '案内表の取得に失敗しました' };
  }
}
