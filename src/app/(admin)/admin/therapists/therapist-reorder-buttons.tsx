"use client";

/**
 * セラピスト並べ替えボタン（クライアントコンポーネント）。
 * 上下矢印ボタンで display_order を入れ替える。
 */

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTherapistOrder } from "@/domain/cms/therapist-actions";
import type { TherapistListItem } from "@/domain/cms/therapist-actions";

interface Props {
  therapists: TherapistListItem[];
  currentIndex: number;
}

export function TherapistReorderButtons({ therapists, currentIndex }: Props) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const canUp = currentIndex > 0;
  const canDown = currentIndex < therapists.length - 1;

  function handleMove(direction: "up" | "down") {
    const newList = [...therapists];
    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;

    // 表示順を入れ替える
    const currentOrder = newList[currentIndex]!.displayOrder;
    const targetOrder = newList[targetIndex]!.displayOrder;

    // 同じ値の場合は index を使う
    const newCurrentOrder = targetOrder !== currentOrder ? targetOrder : currentIndex - (direction === "up" ? 1 : -1);
    const newTargetOrder = targetOrder !== currentOrder ? currentOrder : targetIndex - (direction === "up" ? 1 : -1);

    const items = [
      { id: newList[currentIndex]!.id, displayOrder: newCurrentOrder },
      { id: newList[targetIndex]!.id, displayOrder: newTargetOrder },
    ];

    startTransition(async () => {
      await updateTherapistOrder(items);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => handleMove("up")}
        disabled={!canUp || isPending}
        aria-label="上に移動"
        className="p-1 border border-adm-border rounded text-adm-text/50 hover:text-adm-primary hover:border-adm-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        style={{ borderRadius: "4px" }}
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => handleMove("down")}
        disabled={!canDown || isPending}
        aria-label="下に移動"
        className="p-1 border border-adm-border rounded text-adm-text/50 hover:text-adm-primary hover:border-adm-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        style={{ borderRadius: "4px" }}
      >
        ↓
      </button>
    </div>
  );
}
