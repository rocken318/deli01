/**
 * 配車ボード・マイページのステータス遷移と遅延判定（フェーズ14 / spec 7-1・7-3）。
 *
 * DB にも Next.js にも依存しない純粋関数。日時は Date（timestamptz の写像）で
 * 受け渡し、now は必ず呼び出し側が注入する（Date.now を埋め込まない）。
 *
 * 遷移は confirmed → enroute → in_service → done の**隣接前進のみ**。
 * 後退・スキップは許さない。cancelled / noshow への遷移は別経路（フェーズ15）で、
 * ここでは扱わない。DB 側の最終防衛線は migrations/0012_dispatch_board.sql の
 * reservations_therapist_guard トリガ（同じルールを二重に持つ）。
 */

/** ワンタップで進められるステータスの並び（spec 7-1「確定→移動中→施術中→完了」） */
export const DISPATCH_FLOW = ["confirmed", "enroute", "in_service", "done"] as const;

export type DispatchStatus = (typeof DISPATCH_FLOW)[number];

export function isDispatchStatus(value: string): value is DispatchStatus {
  return (DISPATCH_FLOW as readonly string[]).includes(value);
}

/**
 * 次に進められるステータス。done（終端）と流れ外のステータス
 * （held/cancelled/noshow）は null。
 */
export function nextStatus(current: string): DispatchStatus | null {
  if (!isDispatchStatus(current)) return null;
  const i = DISPATCH_FLOW.indexOf(current);
  return DISPATCH_FLOW[i + 1] ?? null;
}

/** from → to が許される遷移か（隣接前進のみ） */
export function canTransition(from: string, to: string): boolean {
  return nextStatus(from) !== null && nextStatus(from) === to;
}

/**
 * 遅延判定（spec 7-1 L691「移動中のまま予定開始時刻を過ぎたら赤」）。
 * status === 'enroute' かつ now が startAt を過ぎている（同時刻は遅延でない）。
 */
export function isDelayed(params: {
  status: string;
  startAt: Date;
  now: Date;
}): boolean {
  return params.status === "enroute" && params.now.getTime() > params.startAt.getTime();
}

/**
 * 退出記録漏れアラート（spec 7-3 L705「退出予定時刻を過ぎても退出記録が
 * 無ければ、管理画面にアラート」）。
 * 退出予定 = end_at（施術終了）。退出記録 = done への遷移（done_at）。
 * 施術中のまま end_at を過ぎたら true。enroute のまま過ぎた場合も
 * （開始遅延がそのまま続いた形）記録が無いことに変わりないため true。
 */
export function isExitOverdue(params: {
  status: string;
  endAt: Date;
  now: Date;
}): boolean {
  return (
    (params.status === "in_service" || params.status === "enroute") &&
    params.now.getTime() > params.endAt.getTime()
  );
}

/**
 * 遷移先ステータスごとに記録するタップタイムスタンプ列（reservations の列名）。
 * in_service は arrived_at（到着）が未記録なら同時に補完する（到着タップを
 * 飛ばして施術開始した場合でも到着記録が残るように）。
 */
export const TAP_TIMESTAMP_COLUMNS: Record<
  Exclude<DispatchStatus, "confirmed">,
  readonly ("enroute_at" | "arrived_at" | "service_started_at" | "done_at")[]
> = {
  enroute: ["enroute_at"],
  in_service: ["arrived_at", "service_started_at"],
  done: ["done_at"],
};
