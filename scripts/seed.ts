import postgres from "postgres";

/**
 * シード（冪等）。フェーズ0では phase-0 スキーマ（用語辞書・サイト設定・
 * フィールド定義）の初期値のみ投入する。エリア40・セラピスト25・予約1年分など
 * spec 18章の本体シードは、該当テーブルが増える後続フェーズで拡張する。
 *
 * 原則: ダミー値はコードにハードコードして本番に埋め込まない。あくまで DB への初期投入で、
 * CMS から変更できることをもって完成とする（spec 18章）。
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL が未設定です");
  process.exit(1);
}

/** 用語辞書の初期値（spec 13-1） */
const terminology: { key: string; value: string }[] = [
  { key: "service_noun", value: "ボディケア" },
  { key: "staff_noun", value: "セラピスト" },
  { key: "session_noun", value: "コース" },
];

/** グローバル設定の初期値（spec 3-6） */
const siteSettings: { key: string; value: unknown }[] = [
  { key: "brand_name", value: "（屋号未設定）" },
  { key: "reception_phone", value: "" },
  { key: "reception_hours", value: "" },
  { key: "footer_note", value: "" },
];

/** CMS 項目定義の初期セット（spec 2-2 の初期項目。以降 CMS から追加可能） */
const fieldDefinitions = [
  {
    entity: "therapist",
    key: "catch_copy",
    label: "キャッチコピー",
    type: "text",
    sort_order: 10,
    is_public: true,
  },
  {
    entity: "therapist",
    key: "intro",
    label: "自己紹介",
    type: "rich_text",
    sort_order: 20,
    is_public: true,
  },
  {
    entity: "therapist",
    key: "good_at",
    label: "得意な施術",
    type: "multi_select",
    sort_order: 30,
    is_public: true,
    is_filterable: true,
    options: { choices: ["オイル", "指圧", "リンパ", "ストレッチ", "足つぼ"] },
  },
  {
    entity: "therapist",
    key: "years_of_experience",
    label: "経験年数",
    type: "number",
    sort_order: 40,
    is_public: true,
  },
] as const;

async function main() {
  const sql = postgres(url as string, { max: 1 });
  try {
    for (const t of terminology) {
      await sql`
        insert into terminology (key, value, locale)
        values (${t.key}, ${t.value}, 'ja')
        on conflict (key, locale) do update set value = excluded.value, updated_at = now()
      `;
    }

    for (const s of siteSettings) {
      await sql`
        insert into site_settings (key, value)
        values (${s.key}, ${JSON.stringify(s.value)}::jsonb)
        on conflict (key) do nothing
      `;
    }

    for (const f of fieldDefinitions) {
      await sql`
        insert into field_definitions
          (entity, key, label, type, options, sort_order, is_public, is_filterable)
        values (
          ${f.entity}, ${f.key}, ${f.label}, ${f.type}::field_type,
          ${"options" in f ? JSON.stringify(f.options) : null}::jsonb,
          ${f.sort_order}, ${f.is_public}, ${"is_filterable" in f ? f.is_filterable : false}
        )
        on conflict (entity, key) do nothing
      `;
    }

    console.log(
      `シード完了: terminology ${terminology.length} / site_settings ${siteSettings.length} / field_definitions ${fieldDefinitions.length}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((e) => {
  console.error("シード失敗:", e);
  process.exit(1);
});
