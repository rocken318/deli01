"use client";

import { useState, useTransition } from "react";
import { saveSiteSetting } from "@/lib/cms/site-settings-actions";
import { saveTerminology } from "@/lib/cms/terminology-actions";

/**
 * サイト設定・用語辞書の1項目編集（保存結果を明示表示）。
 * 以前は Server Action の素フォーム（defaultValue・フィードバック無し）で、
 * 「保存しても反映が分からない/入力値が送られない」状態だった。controlled input で
 * 入力値を確実に送り、保存の成否を表示する。管理側なので日本語直書き可。
 */
export function SettingRow({
  kind,
  fieldKey,
  label,
  initialValue,
  multiline = false,
}: {
  kind: "setting" | "term";
  fieldKey: string;
  label: string;
  initialValue: string;
  multiline?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setMsg(null);
    start(async () => {
      const r =
        kind === "setting"
          ? await saveSiteSetting(fieldKey, value)
          : await saveTerminology(fieldKey, value, "ja");
      setMsg(
        r.ok
          ? { ok: true, text: "保存しました" }
          : { ok: false, text: r.error ?? "保存に失敗しました" },
      );
    });
  }

  return (
    <div className="flex items-start gap-3">
      <label className="w-48 shrink-0 pt-1.5 text-sm text-adm-text">{label}</label>
      <div className="flex-1">
        {multiline ? (
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={2}
            className="w-full resize-none rounded border border-adm-border bg-adm-bg px-3 py-1.5 text-sm text-adm-text focus:border-adm-primary focus:outline-none"
          />
        ) : (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded border border-adm-border bg-adm-bg px-3 py-1.5 text-sm text-adm-text focus:border-adm-primary focus:outline-none"
          />
        )}
        {msg && (
          <p
            role={msg.ok ? "status" : "alert"}
            className={`mt-1 text-xs ${msg.ok ? "text-adm-primary" : "text-adm-danger"}`}
          >
            {msg.text}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="shrink-0 rounded bg-adm-primary px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "保存中…" : "保存"}
      </button>
    </div>
  );
}
