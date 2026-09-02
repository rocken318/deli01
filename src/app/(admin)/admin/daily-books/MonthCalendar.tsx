"use client";

/**
 * 日次会計の日付選択カレンダー（G2）。dateISO の月を表示し、日クリックで
 * その日の日次ビューへ（onPick）。選択日・当日を強調。純表示＋コールバック。
 */

const DOW = ["日", "月", "火", "水", "木", "金", "土"];

/** dateISO の月のセル（前後の空白込み・Sun 始まり）を返す。 */
function monthCells(dateISO: string): (string | null)[] {
  const [y, m] = dateISO.split("-").map(Number);
  const firstDow = new Date(Date.UTC(y!, m! - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${dateISO.slice(0, 7)}-${String(d).padStart(2, "0")}`);
  }
  return cells;
}

export default function MonthCalendar({
  dateISO,
  todayISO,
  onPick,
}: {
  dateISO: string;
  todayISO: string;
  onPick: (d: string) => void;
}) {
  const cells = monthCells(dateISO);
  return (
    <div className="inline-block border border-adm-line rounded p-2 bg-adm-surface">
      <div className="grid grid-cols-7 gap-1 text-center">
        {DOW.map((w, i) => (
          <div key={w} className={`text-xs font-semibold py-0.5 ${i === 0 ? "text-adm-danger" : i === 6 ? "text-adm-primary" : "text-adm-muted"}`}>
            {w}
          </div>
        ))}
        {cells.map((c, i) =>
          c === null ? (
            <div key={`e${i}`} />
          ) : (
            <button
              key={c}
              type="button"
              onClick={() => onPick(c)}
              className={`text-sm rounded w-9 h-8 tabular-nums ${
                c === dateISO
                  ? "bg-adm-primary text-white font-bold"
                  : c === todayISO
                    ? "border border-adm-primary text-adm-primary"
                    : "text-adm-text hover:bg-adm-bg"
              }`}
            >
              {Number(c.slice(8))}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
