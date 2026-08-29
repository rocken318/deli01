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
 * 公開側の UI 文言・ナビ・法令表記（spec 3-6 / 13-1 / 13-3）。
 * 公開テンプレートは日本語を直書きしないため、ボタン/見出し/空状態などの文言は
 * すべて site_settings.ui_labels / nav_items / terminology から解決する。
 * ここはあくまで初期投入で、CMS から変更できることをもって完成とする（spec 18章）。
 *
 * 既存キー（brand_name / reception_phone / reception_hours / footer_note）は
 * フェーズ0の初期値を尊重して上書きしない（do nothing のまま）。公開ページは
 * それらが空でも構造が崩れないよう条件描画にしてある。ここでは公開に必要な
 * 新規キー（nav_items / social_links / ui_labels / legal_note）のみを投入する。
 */
const publicSiteSettings: { key: string; value: unknown }[] = [
  {
    key: "legal_note",
    value: "特定商取引法に基づく表記・キャンセルポリシーは各ページをご確認ください。",
  },
  {
    key: "nav_items",
    value: [
      { href: "/therapists", label: "セラピスト" },
      { href: "/schedule", label: "出勤表" },
      { href: "/courses", label: "コース" },
      { href: "/areas", label: "エリア" },
      { href: "/guide", label: "ご利用ガイド" },
      { href: "/faq", label: "よくある質問" },
    ],
  },
  {
    key: "social_links",
    value: [] as { href: string; label: string }[],
  },
  {
    key: "ui_labels",
    value: {
      // レイアウト・ナビ
      nav_aria: "サイトナビゲーション",
      footer_nav_aria: "フッターナビゲーション",
      booking_cta: "空き枠を確認して予約する",
      booking_href: "/booking",
      // トップ
      therapists_section_title: "いま案内できるセラピスト",
      view_all_therapists: "セラピストをすべて見る",
      empty_home_title: "準備中です",
      empty_home_body: "公開ページの内容は管理画面から設定します。",
      // 一覧
      therapists_page_title: "セラピスト",
      therapists_page_lead: "得意な施術から選べます。",
      filter_good_at_heading: "得意な施術で絞り込む",
      filter_all: "すべて",
      therapist_detail_cta: "プロフィールを見る",
      // 署名要素（{time} を空き枠エンジンの値で差し替え。フェーズ9まで pending）
      earliest_slot_template: "最短 {time} から案内可能",
      earliest_slot_pending: "調整中",
      // 空状態
      empty_therapists_title: "該当するセラピストがいません",
      empty_therapists_body: "絞り込み条件を変えてお試しください。",
      empty_page_title: "準備中です",
      empty_page_body: "この内容は管理画面から公開できます。",
      back_home: "トップへ戻る",
      // スタブ（フェーズ8/11）
      schedule_page_title: "出勤表",
      schedule_pending_title: "出勤表は準備中です",
      schedule_pending_body: "日別の派遣可能一覧は近日公開します。",
      booking_page_title: "予約",
      booking_pending_title: "オンライン予約は準備中です",
      booking_pending_body: "お電話でのご予約を承っています。",
    },
  },
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
    key: "name",
    label: "氏名・芸名",
    type: "text",
    sort_order: 2,
    is_public: true,
  },
  {
    entity: "therapist",
    key: "photo",
    label: "写真（複数枚）",
    type: "image_gallery",
    sort_order: 5,
    is_public: true,
  },
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

// ---------------------------------------------------------------------------
// フェーズ4: セラピストシード（spec 18-5 / 3-7・3-8）
// ---------------------------------------------------------------------------

/**
 * セラピストプレースホルダ画像（spec 3-7: 実在人物写真は使用不可）。
 * 各セラピストにイニシャル入りの抽象 SVG を使う。
 */
function therapistSvgDataUri(initial: string, from: string, to: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800" role="img" aria-label="セラピストシルエット">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="800" height="800" fill="url(#g)"/>` +
    `<circle cx="400" cy="300" r="160" fill="#ffffff" opacity="0.15"/>` +
    `<ellipse cx="400" cy="600" rx="220" ry="180" fill="#ffffff" opacity="0.10"/>` +
    `<text x="400" y="380" text-anchor="middle" font-family="serif" font-size="200" fill="#ffffff" opacity="0.6">${initial}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * セラピスト用メディアシード（プレースホルダ）。
 * bbbbbbbb-0001〜: セラピスト写真枠。
 * 同意フラグの違いで publishTherapistProfile の掲載同意ゲートをデモできる。
 */
const therapistMediaSeeds = [
  // あおい: 同意あり（公開可能）
  {
    id: "bbbbbbbb-0001-4000-8000-000000000001",
    url: therapistSvgDataUri("蒼", "#8a7ead", "#5e8fa8"),
    alt: "セラピスト「あおい」プレースホルダー（本番公開前に差し替えること）",
    tags: ["placeholder", "therapist", "aoi"],
    consent_flag: true,
    consent_date: "2026-01-01",
    // 目線入り（spec 3-7）の表示デモ。公開ページで .eye-overlay の帯が乗る。
    face_visibility: "eyes",
    is_placeholder: true,
  },
  // みなと: 同意なし（publishTherapistProfile のゲートデモ用）
  {
    id: "bbbbbbbb-0001-4000-8000-000000000002",
    url: therapistSvgDataUri("湊", "#7eadad", "#5e8f7e"),
    alt: "セラピスト「みなと」プレースホルダー（掲載同意未取得 / 本番公開前に差し替えること）",
    tags: ["placeholder", "therapist", "minato"],
    consent_flag: false,
    consent_date: null,
    face_visibility: "none",
    is_placeholder: true,
  },
  // ひなた: 同意あり（退職済みのためis_hiddenデモ用）
  {
    id: "bbbbbbbb-0001-4000-8000-000000000003",
    url: therapistSvgDataUri("陽", "#ada87e", "#a88e5e"),
    alt: "セラピスト「ひなた」プレースホルダー（退職済み / 本番公開前に差し替えること）",
    tags: ["placeholder", "therapist", "hinata"],
    consent_flag: true,
    consent_date: "2026-01-01",
    face_visibility: "none",
    is_placeholder: true,
  },
] as const;

/** セラピストマスタシード（spec 18-5） */
const therapistSeeds = [
  { slug: "aoi",    status: "active",   display_order: 1, retired_at: null },
  { slug: "minato", status: "active",   display_order: 2, retired_at: null },
  { slug: "hinata", status: "retired",  display_order: 3, retired_at: new Date("2026-04-01") },
] as const;

/** セラピストの entity_records シード（draft のみ。公開は管理画面から手動） */
const therapistRecordSeeds: {
  slug: string;
  draft: Record<string, unknown>;
}[] = [
  {
    slug: "aoi",
    draft: {
      // photo（image_gallery）: 同意ありのメディアを参照（publishTherapistProfile で公開可能）
      photo: ["bbbbbbbb-0001-4000-8000-000000000001"],
      name: "あおい",
      catch_copy: "心地よい圧で、あなたの体をほぐします",
      intro: "<p>オイルとリンパを得意とするセラピストです。</p>",
      good_at: ["オイル", "リンパ"],
      years_of_experience: 5,
    },
  },
  {
    slug: "minato",
    draft: {
      // photo（image_gallery）: 同意なしのメディアを参照（publishTherapistProfile がブロックされるデモ用）
      photo: ["bbbbbbbb-0001-4000-8000-000000000002"],
      name: "みなと",
      catch_copy: "丁寧な施術で、日々の疲れをリセット",
      intro: "<p>指圧とストレッチを中心に、幅広いコースに対応します。</p>",
      good_at: ["指圧", "ストレッチ"],
      years_of_experience: 3,
    },
  },
  {
    slug: "hinata",
    draft: {
      // photo（image_gallery）: 同意ありのメディア（退職処理で is_hidden 化されるデモ用）
      photo: ["bbbbbbbb-0001-4000-8000-000000000003"],
      name: "ひなた",
      catch_copy: "足つぼで体の芯から癒します",
      intro: "<p>足つぼを専門とするセラピストです。</p>",
      good_at: ["足つぼ"],
      years_of_experience: 2,
    },
  },
];

// ---------------------------------------------------------------------------
// フェーズ6: エリア・移動時間・バッファ（spec 4章・5-1・5-2・18章 / 冪等）
// Google Maps Distance Matrix API は未キーのため、車マトリクスは手動の暫定値
// （判断ログ参照）。CMS で人手上書きできることが正の運用（spec 5-1）。
// ---------------------------------------------------------------------------

/**
 * エリア（spec 3-8 / 4章）。center は代表点の経緯度（lon, lat / WGS84）。
 * 配置の意図:
 * - 目黒区の代表点と恵比寿駅は約1.2km（徒歩上限1.6km 以内 → walk になる例）
 * - 八王子市は他の全区から遠方（車 or unreachable になる例）
 */
const areaSeeds: {
  id: string;
  name: string;
  kind: "ward" | "city" | "station";
  lon: number;
  lat: number;
  sort_order: number;
}[] = [
  { id: "cccccccc-0000-4000-8000-000000000001", name: "渋谷区", kind: "ward", lon: 139.6982, lat: 35.664, sort_order: 10 },
  { id: "cccccccc-0000-4000-8000-000000000002", name: "新宿区", kind: "ward", lon: 139.7034, lat: 35.6938, sort_order: 20 },
  { id: "cccccccc-0000-4000-8000-000000000003", name: "港区", kind: "ward", lon: 139.7516, lat: 35.6581, sort_order: 30 },
  { id: "cccccccc-0000-4000-8000-000000000004", name: "目黒区", kind: "ward", lon: 139.6982, lat: 35.6415, sort_order: 40 },
  { id: "cccccccc-0000-4000-8000-000000000005", name: "世田谷区", kind: "ward", lon: 139.6532, lat: 35.6461, sort_order: 50 },
  { id: "cccccccc-0000-4000-8000-000000000006", name: "品川区", kind: "ward", lon: 139.7302, lat: 35.6092, sort_order: 60 },
  { id: "cccccccc-0000-4000-8000-000000000007", name: "中野区", kind: "ward", lon: 139.6638, lat: 35.7074, sort_order: 70 },
  { id: "cccccccc-0000-4000-8000-000000000008", name: "豊島区", kind: "ward", lon: 139.7164, lat: 35.7263, sort_order: 80 },
  { id: "cccccccc-0000-4000-8000-000000000009", name: "恵比寿駅", kind: "station", lon: 139.7101, lat: 35.6467, sort_order: 90 },
  { id: "cccccccc-0000-4000-8000-000000000010", name: "八王子市", kind: "city", lon: 139.316, lat: 35.6664, sort_order: 100 },
];

/** エリア名 → id（マトリクス定義を読みやすくする） */
const areaId = new Map(areaSeeds.map((a) => [a.name, a.id]));

/**
 * 車のエリア間移動時間マトリクス（分 / 双方向に同値で展開）。
 * 近隣 8〜20分、遠方（八王子）45〜60分の差をつける（spec 18章の現実的分布）。
 * 未登録ペア（例: 豊島区↔品川区）は暫定値経路（provisionalCarMinutes）のデモに残す。
 */
const carMatrixSeeds: { from: string; to: string; minutes: number }[] = [
  { from: "渋谷区", to: "新宿区", minutes: 15 },
  { from: "渋谷区", to: "港区", minutes: 18 },
  { from: "渋谷区", to: "目黒区", minutes: 12 },
  { from: "渋谷区", to: "世田谷区", minutes: 16 },
  { from: "渋谷区", to: "中野区", minutes: 20 },
  { from: "渋谷区", to: "恵比寿駅", minutes: 8 },
  { from: "新宿区", to: "中野区", minutes: 12 },
  { from: "新宿区", to: "豊島区", minutes: 15 },
  { from: "港区", to: "品川区", minutes: 15 },
  { from: "目黒区", to: "品川区", minutes: 12 },
  { from: "目黒区", to: "恵比寿駅", minutes: 8 },
  { from: "渋谷区", to: "八王子市", minutes: 60 },
  { from: "新宿区", to: "八王子市", minutes: 55 },
  { from: "世田谷区", to: "八王子市", minutes: 45 },
];

/** 時間帯係数（spec 5-1: 深夜 < 1、朝夕 1.3〜1.5）。深夜は日跨ぎ区間 */
const timeModifierSeeds: {
  id: string;
  label: string;
  time_from: string;
  time_to: string;
  multiplier: string;
  additional: number;
  sort_order: number;
}[] = [
  {
    id: "eeeeeeee-0000-4000-8000-000000000001",
    label: "深夜（道が空く）",
    time_from: "23:00",
    time_to: "05:00",
    multiplier: "0.75",
    additional: 0,
    sort_order: 10,
  },
  {
    id: "eeeeeeee-0000-4000-8000-000000000002",
    label: "朝の通勤帯",
    time_from: "07:00",
    time_to: "09:30",
    multiplier: "1.40",
    additional: 0,
    sort_order: 20,
  },
  {
    id: "eeeeeeee-0000-4000-8000-000000000003",
    label: "夕の通勤帯",
    time_from: "17:00",
    time_to: "19:30",
    multiplier: "1.30",
    additional: 0,
    sort_order: 30,
  },
];

/** 待機場所（spec 3-3: 自宅／最寄り駅／事務所） */
const baseSeeds: {
  id: string;
  name: string;
  kind: "home" | "station" | "office";
  lon: number;
  lat: number;
}[] = [
  { id: "dddddddd-0000-4000-8000-000000000001", name: "事務所（渋谷）", kind: "office", lon: 139.7005, lat: 35.6595 },
  { id: "dddddddd-0000-4000-8000-000000000002", name: "新宿駅 待機", kind: "station", lon: 139.7003, lat: 35.6896 },
  { id: "dddddddd-0000-4000-8000-000000000003", name: "自宅待機（中野）", kind: "home", lon: 139.6657, lat: 35.7056 },
];

/**
 * 移動バッファ（spec 5-2）。既定: 到着前10・駐車15・施術前5・施術後10。
 * 都心（港区）は駐車バッファ20分に上書き（エリア別上書きの実証）。
 */
const travelBufferSeeds: {
  id: string;
  scope: "default" | "area";
  area: string | null;
  arrive_min: number;
  parking_min: number;
  before_min: number;
  after_min: number;
}[] = [
  {
    id: "ffffffff-0000-4000-8000-000000000001",
    scope: "default",
    area: null,
    arrive_min: 10,
    parking_min: 15,
    before_min: 5,
    after_min: 10,
  },
  {
    id: "ffffffff-0000-4000-8000-000000000002",
    scope: "area",
    area: "港区",
    arrive_min: 10,
    parking_min: 20,
    before_min: 5,
    after_min: 10,
  },
];

/** 徒歩上書きの例（spec 5-1: 川・線路等の分断区間は迂回係数が効かない） */
const walkOverrideSeeds: { from: string; to: string; added_minutes: number; note: string }[] = [
  {
    from: "品川区",
    to: "港区",
    added_minutes: 8,
    note: "運河・橋を渡るため直線距離より時間がかかる区間",
  },
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

    // 公開側の初期文言・ナビ・法令表記（do update で公開ページが空にならない初期値を投入）
    for (const s of publicSiteSettings) {
      await sql`
        insert into site_settings (key, value)
        values (${s.key}, ${sql.json(s.value as postgres.JSONValue)})
        on conflict (key) do update set value = excluded.value, updated_at = now()
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

    // -----------------------------------------------------------------------
    // フェーズ4: セラピスト（therapists + media + entity_records）
    // -----------------------------------------------------------------------

    for (const m of therapistMediaSeeds) {
      await sql`
        insert into media (id, url, alt, tags, consent_flag, consent_date, face_visibility, is_placeholder)
        values (
          ${m.id}::uuid,
          ${m.url},
          ${m.alt},
          ${m.tags as unknown as string[]}::text[],
          ${m.consent_flag},
          ${m.consent_date ?? null},
          ${m.face_visibility}::face_visibility,
          ${m.is_placeholder}
        )
        on conflict (id) do update set
          alt          = excluded.alt,
          consent_flag = excluded.consent_flag,
          consent_date = excluded.consent_date,
          tags         = excluded.tags,
          is_placeholder = excluded.is_placeholder
      `;
    }

    for (const t of therapistSeeds) {
      await sql`
        insert into therapists (slug, status, display_order, retired_at)
        values (
          ${t.slug},
          ${t.status}::therapist_status,
          ${t.display_order},
          ${t.retired_at ?? null}
        )
        on conflict (slug) do update set
          status        = excluded.status,
          display_order = excluded.display_order,
          retired_at    = excluded.retired_at
      `;
    }

    for (const r of therapistRecordSeeds) {
      await sql`
        insert into entity_records (entity, slug, draft)
        values ('therapist', ${r.slug}, ${sql.json(r.draft as postgres.JSONValue)})
        on conflict (entity, slug) do nothing
      `;
    }

    // みなと: photo（image_gallery）が consent_flag=false のメディアを参照するため、
    // publishTherapistProfile の掲載同意ゲートで公開がブロックされる（spec 3-7 / 2-2）。
    // photo 値は therapistRecordSeeds の draft に image_gallery（string[]）として含める。
    // 既存 draft に photo が無い場合の後方互換フォールバック（配列で補完）。
    await sql`
      update entity_records
      set draft = jsonb_set(
        draft,
        '{photo}',
        to_jsonb(array[${"bbbbbbbb-0001-4000-8000-000000000002"}]::text[])
      )
      where entity = 'therapist' and slug = 'minato'
        and not (draft ? 'photo')
    `;

    // -----------------------------------------------------------------------
    // フェーズ5: 公開に必要な published データ（冪等）
    // -----------------------------------------------------------------------

    // 同意済みセラピスト（aoi/hinata）を published に（掲載同意ゲートを通した想定）。
    // publishTherapistProfile と同じく draft → published へコピーする。
    // minato は未同意（写真 consent_flag=false）なので published は null のまま
    //   ＝ listPublicTherapists / getPublicTherapist に出ない（spec 2-2 / 3-7）。
    // hinata は published にするが therapists.status='retired' のため一覧・個人ページには
    //   出ない（退職除外のデモ。listPublicTherapists は status='active' で絞る）。
    for (const slug of ["aoi", "hinata"]) {
      await sql`
        update entity_records
        set published = draft, published_at = now()
        where entity = 'therapist' and slug = ${slug}
          and published is null
      `;
    }

    // トップの pages(home) を published に（draft → published コピー）。
    // 公開ページ / の pages(home) ブロックを描画するため。
    await sql`
      update pages
      set published_fields = draft_fields,
          published_blocks = draft_blocks,
          published_at = now()
      where slug = 'home' and locale = 'ja'
        and published_at is null
    `;

    // -----------------------------------------------------------------------
    // フェーズ6: エリア・移動時間・バッファ（冪等）
    // -----------------------------------------------------------------------

    for (const a of areaSeeds) {
      await sql`
        insert into areas (id, name, kind, center, sort_order, is_active)
        values (
          ${a.id}::uuid, ${a.name}, ${a.kind},
          st_setsrid(st_makepoint(${a.lon}::float8, ${a.lat}::float8), 4326)::geography,
          ${a.sort_order}, true
        )
        on conflict (id) do update set
          name       = excluded.name,
          kind       = excluded.kind,
          center     = excluded.center,
          sort_order = excluded.sort_order,
          is_active  = excluded.is_active
      `;
    }

    // 車マトリクス（双方向に同値で展開。CMS で片方向だけ直せる余地を残すため行は分ける）
    for (const m of carMatrixSeeds) {
      const fromId = areaId.get(m.from);
      const toId = areaId.get(m.to);
      if (!fromId || !toId) throw new Error(`マトリクスのエリア名が不正: ${m.from} → ${m.to}`);
      for (const [f, t] of [
        [fromId, toId],
        [toId, fromId],
      ] as const) {
        await sql`
          insert into area_travel_times (from_area_id, to_area_id, minutes)
          values (${f}::uuid, ${t}::uuid, ${m.minutes})
          on conflict (from_area_id, to_area_id) do update set minutes = excluded.minutes
        `;
      }
    }

    // 徒歩設定（単一行 / spec 5-1 既定: 迂回1.30・分速80・上限1600m）
    await sql`
      insert into walk_settings (id, detour_factor, speed_m_per_min, cap_meters)
      values (true, 1.30, 80, 1600)
      on conflict (id) do nothing
    `;

    // 徒歩上書き（分断区間。両方向に展開）
    for (const w of walkOverrideSeeds) {
      const fromId = areaId.get(w.from);
      const toId = areaId.get(w.to);
      if (!fromId || !toId) throw new Error(`徒歩上書きのエリア名が不正: ${w.from} → ${w.to}`);
      for (const [f, t] of [
        [fromId, toId],
        [toId, fromId],
      ] as const) {
        await sql`
          insert into walk_overrides (from_area_id, to_area_id, added_minutes, note)
          values (${f}::uuid, ${t}::uuid, ${w.added_minutes}, ${w.note})
          on conflict (from_area_id, to_area_id) do update set
            added_minutes = excluded.added_minutes,
            note          = excluded.note
        `;
      }
    }

    for (const tm of timeModifierSeeds) {
      await sql`
        insert into travel_time_modifiers
          (id, label, time_from, time_to, multiplier, additional, sort_order)
        values (
          ${tm.id}::uuid, ${tm.label}, ${tm.time_from}::time, ${tm.time_to}::time,
          ${tm.multiplier}::numeric, ${tm.additional}, ${tm.sort_order}
        )
        on conflict (id) do update set
          label      = excluded.label,
          time_from  = excluded.time_from,
          time_to    = excluded.time_to,
          multiplier = excluded.multiplier,
          additional = excluded.additional,
          sort_order = excluded.sort_order
      `;
    }

    for (const b of baseSeeds) {
      await sql`
        insert into bases (id, name, kind, location, is_active)
        values (
          ${b.id}::uuid, ${b.name}, ${b.kind},
          st_setsrid(st_makepoint(${b.lon}::float8, ${b.lat}::float8), 4326)::geography,
          true
        )
        on conflict (id) do update set
          name     = excluded.name,
          kind     = excluded.kind,
          location = excluded.location
      `;
    }

    for (const tb of travelBufferSeeds) {
      const tbAreaId = tb.area === null ? null : (areaId.get(tb.area) ?? null);
      if (tb.area !== null && tbAreaId === null) {
        throw new Error(`バッファのエリア名が不正: ${tb.area}`);
      }
      await sql`
        insert into travel_buffers
          (id, scope, area_id, arrive_min, parking_min, before_min, after_min)
        values (
          ${tb.id}::uuid, ${tb.scope}, ${tbAreaId}::uuid,
          ${tb.arrive_min}, ${tb.parking_min}, ${tb.before_min}, ${tb.after_min}
        )
        on conflict (id) do update set
          scope       = excluded.scope,
          area_id     = excluded.area_id,
          arrive_min  = excluded.arrive_min,
          parking_min = excluded.parking_min,
          before_min  = excluded.before_min,
          after_min   = excluded.after_min
      `;
    }

    console.log(
      `シード完了: terminology ${terminology.length} / site_settings ${siteSettings.length} / field_definitions ${fieldDefinitions.length} / app_users ${appUsers.length} / entity_records ${entityRecordSamples.length} / pages ${pageSeeds.length} / media ${mediaSeeds.length} / banned_words ${bannedWordSeeds.length} / therapists ${therapistSeeds.length} / areas ${areaSeeds.length} / area_travel_times ${carMatrixSeeds.length * 2} / travel_time_modifiers ${timeModifierSeeds.length} / bases ${baseSeeds.length} / travel_buffers ${travelBufferSeeds.length}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((e) => {
  console.error("シード失敗:", e);
  process.exit(1);
});
