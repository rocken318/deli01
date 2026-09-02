"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import BookingPopup, { type CourseOpt, type OptionOpt, type AreaOpt } from "./BookingPopup";

/** 板の各行の「この子に予約」ランチャー。クリックで下にインライン予約ポップを開く。 */
export default function BookingLauncher({
  therapistId,
  therapistSlug,
  courses,
  options,
  areas,
}: {
  therapistId: string;
  therapistSlug: string;
  courses: CourseOpt[];
  options: OptionOpt[];
  areas: AreaOpt[];
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
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
          onCreated={() => {
            // 完了表示（✓）はポップ側で出す。板の実績反映のためサーバ再取得のみ。
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
