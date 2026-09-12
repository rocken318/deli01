"use client";

/**
 * 案内表の行ごとの予約エリア（クライアントコンポーネント）。
 * タイムライン帯の gap クリック → BookingLauncher を開き、
 * その枠の希望開始時刻（initialStartMs）を渡す。
 */

import { useState } from "react";
import DayTimeline from "./DayTimeline";
import BookingLauncher from "./BookingLauncher";
import type { TimelineSegment } from "@/domain/annai";
import type { CourseOpt, OptionOpt, AreaOpt } from "./BookingPopup";

interface RowBookingAreaProps {
  segments: TimelineSegment[];
  opDay: string;
  therapistId: string;
  therapistSlug: string;
  courses: CourseOpt[];
  options: OptionOpt[];
  areas: AreaOpt[];
}

export default function RowBookingArea({
  segments,
  opDay,
  therapistId,
  therapistSlug,
  courses,
  options,
  areas,
}: RowBookingAreaProps) {
  // gap クリック時に渡す希望開始時刻（undefined = ボタンから直接開いた）
  const [gapStartMs, setGapStartMs] = useState<number | undefined>(undefined);

  const handlePickGap = (startMs: number) => {
    setGapStartMs(startMs);
  };

  const handleClose = () => {
    setGapStartMs(undefined);
  };

  return (
    <>
      <DayTimeline segments={segments} opDay={opDay} onPickGap={handlePickGap} />
      <BookingLauncher
        therapistId={therapistId}
        therapistSlug={therapistSlug}
        courses={courses}
        options={options}
        areas={areas}
        initialStartMs={gapStartMs}
        onClose={handleClose}
      />
    </>
  );
}
