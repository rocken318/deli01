/**
 * /admin/lineup — 表ページ（公開トップ）の「すぐ迎えるセラピスト」並び順管理。
 *
 * 公開トップは公開中・稼働中セラピストを display_order 順でカード表示する。
 * ここで上下に並べ替えると、その順序がそのまま表ページに反映される。
 * 各行に「最短で案内できる時間（すぐ迎えるか）」を best-effort で表示する（spec 5-4）。
 * デザインは spec 12-2（管理側）。
 */

import type { Metadata } from "next";
import Link from "next/link";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { getFrontLineup } from "@/lib/lineup/queries";
import { earliestSlotForTherapist, type EarliestSlotInfo } from "@/lib/availability/earliest";
import { addDaysISO, localDateISO } from "@/domain/availability";
import LineupList, { type LineupRow } from "./LineupList";

export const metadata: Metadata = { title: "表ページ並び順" };
export const dynamic = "force-dynamic";

/** 最短案内 → 表示ラベルと「すぐ迎える(本日枠あり)」判定 */
function toLabel(
  info: EarliestSlotInfo | null,
  today: string,
  tomorrow: string,
): { label: string | null; soon: boolean } {
  if (!info) return { label: null, soon: false };
  const when =
    info.dateISO === today ? "本日" : info.dateISO === tomorrow ? "明日" : info.dateISO;
  const area = info.assumed && info.areaName ? `（${info.areaName}の場合）` : "";
  return { label: `${when} ${info.time}〜案内可能${area}`, soon: info.dateISO === today };
}

export default async function LineupPage() {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return (
      <div
        role="alert"
        className="border border-adm-danger p-4 text-sm text-adm-danger"
        style={{ borderRadius: "4px" }}
      >
        <p className="font-medium">アクセス権限がありません</p>
        <p className="mt-1 text-xs">このページは owner または admin のロールが必要です。</p>
      </div>
    );
  }

  const lineup = await getFrontLineup(session);

  // 最短案内時刻を best-effort で付ける（各6秒でタイムアウト＝調整中扱い）
  const today = localDateISO(new Date());
  const tomorrow = addDaysISO(today, 1);
  const rows: LineupRow[] = await Promise.all(
    lineup.map(async (t): Promise<LineupRow> => {
      const info = await Promise.race([
        earliestSlotForTherapist(t.slug).catch(() => null),
        new Promise<EarliestSlotInfo | null>((resolve) => setTimeout(() => resolve(null), 6000)),
      ]);
      const { label, soon } = toLabel(info, today, tomorrow);
      return { id: t.id, slug: t.slug, name: t.name, earliestLabel: label, soon };
    }),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-adm-text">表ページ並び順</h1>
          <p className="text-sm text-adm-text/60 mt-1">
            公開トップに出るセラピストの並び順です。上下で入れ替えるとそのまま表ページに反映されます。
          </p>
        </div>
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          className="px-4 py-2 text-sm border border-adm-border hover:border-adm-primary hover:text-adm-primary shrink-0"
          style={{ borderRadius: "4px" }}
        >
          表ページを見る ↗
        </a>
      </div>

      <LineupList initial={rows} />

      <p className="text-xs text-adm-text/50">
        ※「すぐ迎える」は本日中に案内できる枠がある目安です（代表エリア概算 / 出勤・移動時間から算出）。
        セラピストの公開/非公開は
        <Link href="/admin/therapists" className="text-adm-primary underline ml-1">
          セラピスト管理
        </Link>
        から。
      </p>
    </div>
  );
}
