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

/**
 * 各ロールのテストアカウント（spec 17章「各役割のテストアカウント」）。
 * すべてダミー。auth_user_id は Supabase Auth の live 配線時に owner/admin が
 * 管理画面から紐付ける（それまで null = ログイン不可の器だけ）。
 * id を固定 UUID にして冪等に upsert する。therapist の therapist_id は
 * therapists テーブルが入るフェーズ4で紐付ける。
 */
const appUsers: {
  id: string;
  role: "owner" | "admin" | "reception" | "therapist";
  display_name: string;
}[] = [
  {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    role: "owner",
    display_name: "（ダミー）オーナー",
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    role: "admin",
    display_name: "（ダミー）管理者",
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000003",
    role: "reception",
    display_name: "（ダミー）受付",
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000004",
    role: "therapist",
    display_name: "（ダミー）セラピスト",
  },
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

/** 動作確認用 entity_records サンプル（フェーズ2 / 冪等） */
const entityRecordSamples: {
  entity: string;
  slug: string;
  draft: Record<string, unknown>;
}[] = [
  {
    entity: "therapist",
    slug: "demo-therapist-01",
    draft: {
      catch_copy: "あなたの体のプロフェッショナル",
      intro: "<p>経験豊富なセラピストです。</p>",
      good_at: ["オイル", "リンパ"],
      years_of_experience: 5,
    },
  },
];

const pageSeeds = [
  {
    slug: "home",
    locale: "ja",
    draft_fields: {
      heading: "あなたに合った、癒しの時間を",
      lead: "出張リラクゼーションで、ご自宅やホテルにお伺いします。",
      heroImageId: null,
      seoTitle: "出張リラクゼーション | トップページ",
      seoDescription: "ご自宅やホテルに出張するリラクゼーションサービスです。",
    },
    draft_blocks: [
      {
        id: "home-hero-1",
        type: "hero",
        visible: true,
        heading: "あなたに合った、癒しの時間を",
        subheading: "出張リラクゼーションで、ご自宅やホテルにお伺いします。",
        imageId: "bbbbbbbb-0000-4000-8000-000000000001",
        ctaLabel: "空き枠を確認する",
        ctaHref: "/booking",
      },
      {
        id: "home-cta-1",
        type: "cta",
        visible: true,
        label: "今すぐ予約する",
        href: "/booking",
        subtext: "最短90分でお伺いします",
      },
    ],
  },
];

/**
 * プレースホルダ画像の実体（spec 3-7 / 12-1）。
 * 自己完結の data-URI SVG（抽象グラデーション）にすることで、Storage 未配線でも
 * プレビュー・公開レンダラーで実際に描画できる。本番公開前に本物へ差し替える
 * （README「本番前チェックリスト」参照）。第12-1章のトーン（落ち着いた暖色〜藤色）。
 */
function gradientSvgDataUri(from: string, to: string, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" role="img" aria-label="${label}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="1200" height="675" fill="url(#g)"/>` +
    `<circle cx="300" cy="180" r="220" fill="#ffffff" opacity="0.08"/>` +
    `<circle cx="960" cy="520" r="300" fill="#ffffff" opacity="0.06"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const mediaSeeds = [
  {
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    storage_path: "",
    url: gradientSvgDataUri("#c9a27e", "#8a6f9e", "ヒーロー画像プレースホルダー"),
    alt: "ヒーロー画像プレースホルダー（本番公開前に差し替えること）",
    tags: ["placeholder", "hero"],
    is_placeholder: true,
  },
  {
    id: "bbbbbbbb-0000-4000-8000-000000000002",
    storage_path: "",
    url: gradientSvgDataUri("#a8846a", "#6f7e9e", "ヒーロー画像プレースホルダー（別トーン）"),
    alt: "ヒーロー画像プレースホルダー（別トーン・本番公開前に差し替えること）",
    tags: ["placeholder", "hero"],
    is_placeholder: true,
  },
  {
    id: "bbbbbbbb-0000-4000-8000-000000000003",
    storage_path: "",
    url: gradientSvgDataUri("#c98e8e", "#9e8a6f", "コース案内画像プレースホルダー"),
    alt: "コース案内画像プレースホルダー（本番公開前に差し替えること）",
    tags: ["placeholder", "course"],
    is_placeholder: true,
  },
  {
    id: "bbbbbbbb-0000-4000-8000-000000000004",
    storage_path: "",
    url: gradientSvgDataUri("#8e9ec9", "#c9a27e", "コース案内画像プレースホルダー（別トーン）"),
    alt: "コース案内画像プレースホルダー（別トーン・本番公開前に差し替えること）",
    tags: ["placeholder", "course"],
    is_placeholder: true,
  },
  {
    id: "bbbbbbbb-0000-4000-8000-000000000005",
    storage_path: "",
    url: gradientSvgDataUri("#9e8ac9", "#7e9e8a", "セラピストシルエットプレースホルダー"),
    alt: "セラピストシルエットプレースホルダー（実在人物写真は使用不可 / spec 3-7）",
    tags: ["placeholder", "therapist"],
    is_placeholder: true,
  },
];

const bannedWordSeeds = [
  "治る", "治ります", "治療", "診断", "医療",
  "効果があります", "改善します", "国家資格", "あん摩", "マッサージ師",
];

async function main() {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
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
        values (${s.key}, ${sql.json(s.value as postgres.JSONValue)})
        on conflict (key) do nothing
      `;
    }

    for (const f of fieldDefinitions) {
      await sql`
        insert into field_definitions
          (entity, key, label, type, options, sort_order, is_public, is_filterable)
        values (
          ${f.entity}, ${f.key}, ${f.label}, ${f.type}::field_type,
          ${"options" in f ? sql.json(f.options as postgres.JSONValue) : null},
          ${f.sort_order}, ${f.is_public}, ${"is_filterable" in f ? f.is_filterable : false}
        )
        on conflict (entity, key) do nothing
      `;
    }

    for (const u of appUsers) {
      await sql`
        insert into app_users (id, role, display_name, is_active)
        values (${u.id}, ${u.role}::app_role, ${u.display_name}, true)
        on conflict (id) do update
          set role = excluded.role,
              display_name = excluded.display_name,
              is_active = true
      `;
    }

    for (const r of entityRecordSamples) {
      await sql`
        insert into entity_records (entity, slug, draft)
        values (${r.entity}, ${r.slug}, ${sql.json(r.draft as postgres.JSONValue)})
        on conflict (entity, slug) do nothing
      `;
    }

    for (const p of pageSeeds) {
      await sql`
        insert into pages (slug, locale, draft_fields, draft_blocks)
        values (${p.slug}, ${p.locale}, ${sql.json(p.draft_fields as postgres.JSONValue)}, ${sql.json(p.draft_blocks as postgres.JSONValue)})
        on conflict (slug, locale) do update set draft_fields = excluded.draft_fields, draft_blocks = excluded.draft_blocks
      `;
    }

    for (const m of mediaSeeds) {
      await sql`
        insert into media (id, storage_path, url, alt, tags, is_placeholder)
        values (${m.id}::uuid, ${m.storage_path}, ${m.url}, ${m.alt}, ${m.tags}::text[], ${m.is_placeholder})
        on conflict (id) do update set alt = excluded.alt, tags = excluded.tags, is_placeholder = excluded.is_placeholder
      `;
    }

    for (const word of bannedWordSeeds) {
      await sql`insert into banned_words (word) values (${word}) on conflict (word) do nothing`;
    }

    console.log(
      `シード完了: terminology ${terminology.length} / site_settings ${siteSettings.length} / field_definitions ${fieldDefinitions.length} / app_users ${appUsers.length} / entity_records ${entityRecordSamples.length} / pages ${pageSeeds.length} / media ${mediaSeeds.length} / banned_words ${bannedWordSeeds.length}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((e) => {
  console.error("シード失敗:", e);
  process.exit(1);
});
