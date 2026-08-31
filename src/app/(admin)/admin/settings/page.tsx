import type { Metadata } from "next";

export const dynamic = "force-dynamic";

import { getAllSiteSettings } from "@/lib/cms/site-settings-actions";
import { getAllTerminology } from "@/lib/cms/terminology-actions";
import { getDevSession } from "@/lib/cms/dev-session";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { SettingRow } from "./setting-row";

export const metadata: Metadata = { title: "サイト設定" };

export default async function SettingsPage() {
  // 機微データの露出防止（本番・未 Auth では 403 相当）。
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return (
      <div className="bg-adm-surface border border-adm-border rounded p-6">
        <p className="text-sm text-adm-text">権限がありません。</p>
      </div>
    );
  }

  const settings = await getAllSiteSettings();
  const terms = await getAllTerminology("ja");

  const settingFields: { key: string; label: string; multiline?: boolean }[] = [
    { key: "brand_name", label: "屋号" },
    { key: "reception_phone", label: "受付電話番号" },
    { key: "reception_hours", label: "受付時間" },
    { key: "footer_note", label: "フッター注記", multiline: true },
    { key: "ops_email", label: "運用先メール（週次レポート等の宛先）" },
  ];

  const termFields: { key: string; label: string }[] = [
    { key: "service_noun", label: "サービス名称（例: ボディケア）" },
    { key: "staff_noun", label: "スタッフ名称（例: セラピスト）" },
    { key: "session_noun", label: "セッション名称（例: コース）" },
  ];

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-adm-text">サイト設定</h1>

      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          グローバル設定
        </h2>
        {settingFields.map((f) => (
          <SettingRow
            key={f.key}
            kind="setting"
            fieldKey={f.key}
            label={f.label}
            initialValue={String(settings[f.key] ?? "")}
            multiline={f.multiline}
          />
        ))}
      </section>

      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          用語辞書
        </h2>
        {termFields.map((f) => (
          <SettingRow
            key={f.key}
            kind="term"
            fieldKey={f.key}
            label={f.label}
            initialValue={terms[f.key] ?? ""}
          />
        ))}
      </section>
    </div>
  );
}
