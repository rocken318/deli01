/**
 * 配車脚の状態候補（設計 4.7）。手動更新・種別ごとに候補が異なる。
 * 送り: 予定→送り中→合流確認中→インコール待機中→バック中→完了
 * 帰り: 向かい中→アウト待ち→バック中→完了
 */
export const SEND_STATES = [
  "予定", "送り中", "合流確認中", "インコール待機中", "バック中", "完了",
] as const;
export const RETURN_STATES = [
  "向かい中", "アウト待ち", "バック中", "完了",
] as const;

export type LegSlot = "send" | "return";

export function statesForSlot(slot: LegSlot): readonly string[] {
  return slot === "send" ? SEND_STATES : RETURN_STATES;
}
export function initialStateForSlot(slot: LegSlot): string {
  return slot === "send" ? "予定" : "向かい中";
}
export function isValidState(slot: LegSlot, state: string): boolean {
  return statesForSlot(slot).includes(state);
}
export function isDoneState(state: string): boolean {
  return state === "完了";
}
export function kindForSlot(slot: LegSlot): "reservation_send" | "reservation_return" {
  return slot === "send" ? "reservation_send" : "reservation_return";
}
