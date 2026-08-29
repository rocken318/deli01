import type { Metadata } from "next";
import { getAllSiteSettings, saveSiteSetting } from "@/lib/cms/site-settings-actions";
import { getAllTerminology, saveTerminology } from "@/lib/cms/terminology-actions";

export const metadata: Metadata = { title: "サイト設定" };

export default async function SettingsPage() {
  const settings = await getAllSiteSettings();
  const terms = await getAllTerminology("ja");

  async function handleSaveSetting(formData: FormData) {
    "use server";
    const key = formData.get("key") as string;
    const value = formData.get("value") as string;
    await saveSiteSetting(key, value);
  }

  async function handleSaveTerm(formData: FormData) {
    "use server";
    const key = formData.get("key") as string;
    const value = formData.get("value") as string;
    await saveTerminology(key, value, "ja");
  }

  const settingFields: { key: string; label: string }[] = [
    { key: "brand_name", label: "屋号" },
    { key: "reception_phone", label: "受付電話番号" },
    { key: "reception_hours", label: "受付時間" },
    { key: "footer_note", label: "フッター注記" },
  ];

  const termFields: { key: string; label: string }[] = [
    { key: "service_noun", label: "サービス名称（例: ボディケア）" },
    { key: "staff_noun", label: "スタッフ名称（例: セラピスト）" },
    { key: "session_noun", label: "セッション名称（例: コース）" },
  ];

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-adm-text">サイト設定</h1>

      {/* サイト設定 */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">グローバル設定</h2>
        {settingFields.map((f) => (
          <form key={f.key} action={handleSaveSetting} className="flex items-center gap-3">
            <input type="hidden" name="key" value={f.key} />
            <label htmlFor={`setting-${f.key}`} className="w-40 text-sm text-adm-text shrink-0">
              {f.label}
            </label>
            <input
              id={`setting-${f.key}`}
              name="value"
              defaultValue={String(settings[f.key] ?? "")}
              className="flex-1 border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary"
            />
            <button
              type="submit"
              className="px-3 py-1.5 text-sm bg-adm-primary text-white rounded hover:opacity-90"
            >
              保存
            </button>
          </form>
        ))}
      </section>

      {/* 用語辞書 */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">用語辞書</h2>
        {termFields.map((f) => (
          <form key={f.key} action={handleSaveTerm} className="flex items-center gap-3">
            <input type="hidden" name="key" value={f.key} />
            <label htmlFor={`term-${f.key}`} className="w-56 text-sm text-adm-text shrink-0">
              {f.label}
            </label>
            <input
              id={`term-${f.key}`}
              name="value"
              defaultValue={terms[f.key] ?? ""}
              className="flex-1 border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary"
            />
            <button
              type="submit"
              className="px-3 py-1.5 text-sm bg-adm-primary text-white rounded hover:opacity-90"
            >
              保存
            </button>
          </form>
        ))}
      </section>
    </div>
  );
}
