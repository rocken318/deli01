/** ホテルの派遣実績を intel から導出（設計 5.4）。 */
export type HotelRecord = "ok" | "caution" | "blocked";

export function deriveHotelRecord(
  isBlocked: boolean,
  entryNote: string | null,
): HotelRecord {
  if (isBlocked) return "blocked";
  if (entryNote != null && entryNote.trimStart().startsWith("△")) return "caution";
  return "ok";
}
