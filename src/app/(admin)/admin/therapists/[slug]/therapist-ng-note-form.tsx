"use client";

/**
 * セラピスト NGメモ編集フォーム（クライアントコンポーネント）。
 * owner/admin のみ編集可（manage_cms）。reception は閲覧のみ。
 */

import { useState, useTransition } from "react";
import { setTherapistNgNote } from "@/lib/therapist/ng-actions";

interface Props {
  therapistId: string;
  initialNgNote: string | null;
  canEdit: boolean;
}

export function TherapistNgNoteForm({ therapistId, initialNgNote, canEdit }: Props) {
  const [value, setValue] = useState(initialNgNote ?? "");
  const [saved, setSaved] = useState(initialNgNote ?? "");
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  const isDirty = value !== saved;

  const handleSave = () => {
    startTransition(async () => {
      const result = await setTherapistNgNote({ therapistId, ngNote: value });
      if (result.ok) {
        setSaved(value);
        setToast({ text: "NGメモを保存しました", ok: true });
        setTimeout(() => setToast(null), 3000);
      } else {
        setToast({ text: result.error ?? "保存に失敗しました", ok: false });
        setTimeout(() => setToast(null), 5000);
      }
    });
  };

  const baseStyle = { borderRadius: "4px" };
  const inputClass =
    "w-full px-3 py-2 text-sm border border-adm-border rounded bg-adm-surface text-adm-text placeholder:text-adm-text/40 focus:outline-none focus:border-adm-primary resize-none";

  return (
    <div className="space-y-3">
      {toast && (
        <div
          role={toast.ok ? "status" : "alert"}
          className={`p-3 text-sm rounded border ${
            toast.ok
              ? "border-adm-primary text-adm-primary"
              : "border-adm-danger text-adm-danger"
          }`}
          style={baseStyle}
        >
          {toast.text}
        </div>
      )}

      <div>
        <label htmlFor="ng_note" className="block text-sm font-medium text-adm-text mb-1">
          NGメモ
          <span className="ml-2 text-xs font-normal text-adm-text/50">
            （例：自宅送迎NG、深夜NG、○○ホテルNG）
          </span>
        </label>
        <textarea
          id="ng_note"
          name="ng_note"
          rows={3}
          maxLength={1000}
          value={value}
          readOnly={!canEdit}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例：自宅送迎NG、深夜NG、○○ホテルNG"
          className={`${inputClass} ${!canEdit ? "cursor-not-allowed opacity-60" : ""}`}
          style={baseStyle}
        />
        <p className="text-xs text-adm-text/50 mt-1">
          {value.length} / 1000字
          {!canEdit && "（閲覧のみ）"}
        </p>
      </div>

      {canEdit && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending || !isDirty}
            className="px-5 py-2 text-sm font-medium bg-adm-primary text-white rounded hover:bg-adm-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={baseStyle}
          >
            {isPending ? "保存中…" : "NGメモを保存"}
          </button>
          {isDirty && (
            <button
              type="button"
              onClick={() => setValue(saved)}
              disabled={isPending}
              className="px-3 py-2 text-sm text-adm-text/50 hover:text-adm-text transition-colors"
            >
              元に戻す
            </button>
          )}
        </div>
      )}
    </div>
  );
}
