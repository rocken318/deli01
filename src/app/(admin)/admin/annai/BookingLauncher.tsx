"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import BookingPopup, { type CourseOpt, type OptionOpt, type AreaOpt } from "./BookingPopup";

/** 板の各行の「この子に予約」ランチャー。クリックで下にインライン予約ポップを開く。
 *  initialStartMs: タイムライン帯の gap クリック時に渡す開始時刻（任意）。
 *  BookingPopup を開いた後、実枠取得後に最も近い枠を初期選択する。
 */
export default function BookingLauncher({
  therapistId,
  therapistSlug,
  courses,
  options,
  areas,
  initialStartMs,
  onClose,
}: {
  therapistId: string;
  therapistSlug: string;
  courses: CourseOpt[];
  options: OptionOpt[];
  areas: AreaOpt[];
  /** gap クリック時に渡す希望開始時刻（ms）。実枠の中から最近傍を初期選択する。 */
  initialStartMs?: number;
  /** gap クリックで開いたとき、外部の state をリセットするコールバック（任意） */
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // initialStartMs が変わったらポップを自動オープン（gap クリック）
  useEffect(() => {
    if (initialStartMs !== undefined) {
      setOpen(true);
    }
  }, [initialStartMs]);

  const handleClose = () => {
    setOpen(false);
    onClose?.();
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (open) handleClose();
          else setOpen(true);
        }}
        aria-expanded={open}
        style={{
          marginTop: 6,
          background: open ? "#EAF3EF" : "#fff",
          border: "1px solid #3F7A6B",
          color: "#3F7A6B",
          borderRadius: 6,
          padding: "6px 12px",
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {open ? "予約を閉じる ▲" : "この子に予約 ▾"}
      </button>
      {open && (
        <BookingPopup
          therapistId={therapistId}
          therapistSlug={therapistSlug}
          courses={courses}
          options={options}
          areas={areas}
          initialStartMs={initialStartMs}
          onCreated={() => {
            // 完了表示（✓）はポップ側で出す。板の実績反映のためサーバ再取得のみ。
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
