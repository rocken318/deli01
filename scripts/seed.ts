import postgres from "postgres";
import { addDaysISO, localDateISO, shiftInstants } from "../src/domain/availability/shift";

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
  // 運用先メール（週次レポート等スタッフ宛通知の実配信先 / v1後(a) メール配線）。
  // 空なら reception_phone にフォールバック（sender はスタブ）。CMS から設定が正。
  { key: "ops_email", value: "" },
  // 予約フローの料金設定（spec 18-3 のダミー初期値 / フェーズ11。CMS から変更が正）
  {
    key: "booking_fees",
    value: {
      transport_walk: 0,
      transport_car: 1000,
      midnight_surcharge: 3000,
      midnight_from_hour: 0,
      midnight_to_hour: 5,
    },
  },
  // キャンセルポリシー（何時間前から何%。spec 6章 L648 の雛形 / フェーズ15。CMS 変更が正）
  {
    key: "cancellation_policy",
    value: {
      tiers: [
        { min_hours_before: 24, percent: 0 }, // 前日まで無料
        { min_hours_before: 3, percent: 30 }, // 3時間前まで 30%
        { min_hours_before: 0, percent: 50 }, // 当日（開始前）50%
      ],
      // 開始後・無断キャンセルは全額（cancellation.ts の AFTER_START_PERCENT）
    },
  },
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
      // プレイ内容ブロックの項目見出しプレフィックス（「プレイ1」「プレイ2」…）
      play_item_label: "プレイ",
      empty_home_title: "準備中です",
      empty_home_body: "公開ページの内容は管理画面から設定します。",
      // ヒーロー下のコンセプトコピー画像（underhero.png）の代替テキストと、
      // 画像内文言の転記（sr-only で読み上げ・検索エンジン向け。ページ実内容の説明）。
      under_hero_alt:
        "王様の休日 — ここは、とある王国の宮殿。王様を癒す派遣型リラクゼーション。最短60分から、ご自宅やホテルへ厳選されたセラピストがお伺いします。",
      under_hero_seo:
        "ここは、とある王国の宮殿。多忙な王様に訪れた、久しぶりの休日。王の間には、マッサージの得意な美女たちが集う。王様は今日のセラピストを選び、やさしく微笑みかける。そう、王様に仕える美女たちの喜びは——王様を癒すこと。その手に、心に、すべてを込めて。国王と美女の間に起こる、束の間の休息をあなたにも。派遣型リラクゼーション。最短60分からお好きな時間にご利用いただけます。ご自宅やホテルへ、セラピストがご指定の場所へお伺いします。厳選された美女、経験豊富なセラピストが極上の癒しをお届けします。さあ、特別なひとときをお楽しみください。",
      // 一覧
      therapists_page_title: "セラピスト",
      therapists_page_lead: "得意な施術から選べます。",
      filter_good_at_heading: "得意な施術で絞り込む",
      filter_all: "すべて",
      therapist_detail_cta: "プロフィールを見る",
      // 署名要素（{time} を空き枠エンジンの値で差し替え。枠が無い間は pending）
      earliest_slot_template: "最短 {time} から案内可能",
      earliest_slot_pending: "調整中",
      // 空き枠パネル（フェーズ10 / spec 2-3・5-4）
      slots_area_heading: "エリアで絞り込む",
      slots_area_all: "おまかせ（代表エリア）",
      slots_course_heading: "コースを選ぶ",
      slots_option_heading: "オプションを選ぶ",
      slots_heading: "案内できる時間",
      slots_condition_template: "{area}であれば案内可能",
      slots_assumed_note: "（代表エリアでの概算です）",
      slots_empty_title: "この条件でご案内できる時間がありません",
      slots_empty_body: "エリアや日付、コースを変えてお試しください。",
      slots_loading: "計算中…",
      slots_error: "時間の取得に失敗しました。時間をおいてお試しください。",
      slots_select_aria: "この時間で予約に進む",
      // 枠の日付表示（当日以外のとき。{date} を M/d(曜) で差し替え）
      slots_date_note: "{date} の空き枠",
      slots_date_today: "本日の空き枠",
      // 最短案内の日付付きテンプレート（当日以外のとき。{date}{time} を差し替え）
      earliest_slot_template_future: "最短 {date} {time} から案内可能",
      // 空状態
      empty_therapists_title: "該当するセラピストがいません",
      empty_therapists_body: "絞り込み条件を変えてお試しください。",
      empty_page_title: "準備中です",
      empty_page_body: "この内容は管理画面から公開できます。",
      back_home: "トップへ戻る",
      // 出勤表（フェーズ8 / spec 2-3・3-3）
      schedule_page_title: "出勤表",
      schedule_page_lead: "日別の出勤予定と、その日ご案内できるエリアです。",
      schedule_date_nav_aria: "日付を選ぶ",
      schedule_area_filter_heading: "エリアで絞り込む",
      schedule_available_badge: "対応可能",
      schedule_disclaimer:
        "出勤中でも、お伺い先のご住所・移動時間によって実際にご案内できる時間は変わります。確定のご案内はご予約時にお伝えします。",
      schedule_empty_title: "この日にご案内できるセラピストがいません",
      schedule_empty_body: "日付やエリアを変えてお試しください。",
      schedule_weekdays: "日,月,火,水,木,金,土",
      // 注文フロー（フェーズ11 / spec 5-5・6章）
      booking_page_title: "予約",
      booking_pending_title: "オンライン予約は準備中です",
      booking_pending_body: "お電話でのご予約を承っています。",
      booking_step_therapist: "セラピストを選ぶ",
      booking_step_destination: "お伺い先を選ぶ",
      booking_dest_home: "ご自宅・ご滞在先",
      booking_dest_hotel: "ホテル",
      booking_hotel_select: "ホテルを選ぶ",
      booking_step_slot: "時間を選ぶ",
      booking_step_details: "お客様情報",
      booking_name_label: "お名前",
      booking_phone_label: "お電話番号（ハイフンなし）",
      booking_address_label: "ご住所",
      booking_address_hotel_label: "派遣先ホテル",
      customer_portal_title: "マイページ",
      customer_portal_name_suffix: "様",
      customer_portal_points: "ポイント残高",
      customer_portal_therapists: "前にご利用の女性",
      customer_portal_profile_cta: "プロフィール ›",
      customer_portal_history: "ご利用・ご予約履歴",
      customer_portal_history_empty: "まだご利用履歴はありません。",
      customer_portal_invalid: "このリンクは無効か、有効期限が切れています。",
      customer_portal_invalid_sub: "お手数ですが、最新のご案内リンクをご確認ください。",
      customer_portal_footer: "このページはお客様専用リンクです。第三者に共有しないでください。",
      customer_portal_status_done: "利用済み",
      customer_portal_status_confirmed: "予約確定",
      customer_portal_status_enroute: "移動中",
      customer_portal_status_in_service: "接客中",
      booking_price_heading: "料金",
      booking_price_course: "コース",
      booking_price_options: "オプション",
      booking_price_nomination: "指名料",
      booking_price_transport: "交通費",
      booking_price_midnight: "深夜加算",
      booking_price_total: "合計",
      booking_price_provisional_note: "（交通費・深夜加算は時間確定時に加算されます）",
      booking_hold_remaining: "仮押さえの残り時間",
      booking_hold_note:
        "この時間はお客様のために確保しています。時間内にご入力ください。",
      booking_choose_another: "別の時間を選び直す",
      booking_confirm_cta: "この内容で予約を確定する",
      booking_confirming: "確定処理中…",
      booking_done_title: "ご予約を承りました",
      booking_done_body:
        "内容確認のお電話を差し上げる場合があります。ご不明点はお電話でお問い合わせください。",
      booking_done_number: "予約番号",
      booking_error_generic: "処理に失敗しました。時間をおいてお試しください。",
      booking_error_slot_taken:
        "他のお客様の予約が先に確定しました。別の時間をお選びください。",
      booking_error_slot_gone:
        "この時間はご案内できなくなりました。別の時間をお選びください。",
      booking_error_hold_expired:
        "仮押さえの有効時間が切れました。もう一度時間をお選びください。",
      booking_error_version: "内容が更新されています。もう一度お試しください。",
      booking_error_invalid: "入力内容をご確認ください。",
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
    display_name: "（ダミー）セラピスト あおい",
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000005",
    role: "therapist",
    display_name: "（ダミー）セラピスト れん",
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
        // null にして公開側の静的ヒーロー（/hero/hero-mobile.jpg・/hero/hero-pc.jpg）へ
        // フォールバックさせる。プレースホルダー SVG を再seedで戻さないため（本番作替の罠回避）。
        imageId: null,
        ctaLabel: "空き枠を確認する",
        ctaHref: "/booking",
      },
      {
        id: "home-play-1",
        type: "play",
        visible: true,
        heading: "コース紹介",
        items: [
          {
            body: "【すごいエステ】エステとリラクゼーションが融合した、当店オリジナルの密着コース。丁寧な洗体からオイルトリートメント、鼠径部リンパマッサージまで、女性からの積極的なおもてなしで、他では味わえない極上のひとときをお届けします。",
          },
          {
            body: "【回春コース】お客様に受け身になっていただき、女性の密着マッサージで心も体も解きほぐすコース。オイルトリートメントと鼠径部リンパマッサージを中心に、日頃の疲れをじっくりと癒やし、満ち足りたひとときへとお導きします。",
          },
        ],
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
 * セラピスト用メディアシード（プレースホルダ）。
 * bbbbbbbb-0001〜: セラピスト写真枠。
 * 同意フラグの違いで publishTherapistProfile の掲載同意ゲートをデモできる。
 */
const therapistMediaSeeds = [
  // あおい: 同意あり（公開可能）
  {
    id: "bbbbbbbb-0001-4000-8000-000000000001",
    url: "/therapists/001.jpg",
    alt: "セラピスト「あおい」ダミー写真（本番公開前に差し替えること）",
    tags: ["placeholder", "therapist", "aoi"],
    consent_flag: true,
    consent_date: "2026-01-01",
    face_visibility: "face",
    is_placeholder: true,
  },
  // みなと: 同意なし（publishTherapistProfile のゲートデモ用）
  {
    id: "bbbbbbbb-0001-4000-8000-000000000002",
    url: "/therapists/003.jpg",
    alt: "セラピスト「みなと」ダミー写真（掲載同意未取得 / 本番公開前に差し替えること）",
    tags: ["placeholder", "therapist", "minato"],
    consent_flag: false,
    consent_date: null,
    face_visibility: "none",
    is_placeholder: true,
  },
  // ひなた: 同意あり（退職済みのためis_hiddenデモ用）
  {
    id: "bbbbbbbb-0001-4000-8000-000000000003",
    url: "/therapists/004.jpg",
    alt: "セラピスト「ひなた」ダミー写真（退職済み / 本番公開前に差し替えること）",
    tags: ["placeholder", "therapist", "hinata"],
    consent_flag: true,
    consent_date: "2026-01-01",
    face_visibility: "none",
    is_placeholder: true,
  },
  // れん: 同意あり（フェーズ8: 出勤表で「全域対応」のデモに使う公開セラピスト）
  {
    id: "bbbbbbbb-0001-4000-8000-000000000004",
    url: "/therapists/002.jpg",
    alt: "セラピスト「れん」ダミー写真（本番公開前に差し替えること）",
    tags: ["placeholder", "therapist", "ren"],
    consent_flag: true,
    consent_date: "2026-01-01",
    face_visibility: "face",
    is_placeholder: true,
  },
] as const;

/** セラピストマスタシード（spec 18-5 + フェーズ8 の出勤表デモ要員 ren） */
const therapistSeeds = [
  { slug: "aoi",    status: "active",   display_order: 1, retired_at: null },
  { slug: "minato", status: "active",   display_order: 2, retired_at: null },
  { slug: "hinata", status: "retired",  display_order: 3, retired_at: new Date("2026-04-01") },
  { slug: "ren",    status: "active",   display_order: 4, retired_at: null },
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
  {
    slug: "ren",
    draft: {
      photo: ["bbbbbbbb-0001-4000-8000-000000000004"],
      name: "れん",
      catch_copy: "仙台全域、深めの指圧が持ち味です",
      intro: "<p>広いエリアに車で伺えるセラピストです。</p>",
      good_at: ["指圧", "オイル"],
      years_of_experience: 7,
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
 * - 国分町の代表点と一番町は約0.7kmで徒歩上限内（徒歩上限1.6km 以内 → walk になる例）
 * - 名取は他の全エリアから遠方（車 or unreachable になる例）
 */
// transport_fee = エリア別の車交通費（税別・整数円・1000円単位 / 発注者決定 2026-09-04）。
// 立町（拠点＝国分町）無料 / その他仙台市中心部 2000 / 泉区・太白区・若林区 3000 / 名取市・富谷市 4000。
const areaSeeds: {
  id: string;
  name: string;
  kind: "ward" | "city" | "station";
  lon: number;
  lat: number;
  sort_order: number;
  transport_fee: number;
}[] = [
  { id: "cccccccc-0000-4000-8000-000000000001", name: "国分町", kind: "ward", lon: 140.8710, lat: 38.2640, sort_order: 10, transport_fee: 0 },
  { id: "cccccccc-0000-4000-8000-000000000002", name: "一番町", kind: "ward", lon: 140.8720, lat: 38.2610, sort_order: 20, transport_fee: 2000 },
  { id: "cccccccc-0000-4000-8000-000000000003", name: "仙台駅前", kind: "station", lon: 140.8823, lat: 38.2601, sort_order: 30, transport_fee: 2000 },
  { id: "cccccccc-0000-4000-8000-000000000004", name: "仙台市中心部", kind: "ward", lon: 140.8770, lat: 38.2625, sort_order: 40, transport_fee: 2000 },
  { id: "cccccccc-0000-4000-8000-000000000005", name: "仙台市内", kind: "city", lon: 140.8694, lat: 38.2682, sort_order: 50, transport_fee: 2000 },
  { id: "cccccccc-0000-4000-8000-000000000006", name: "泉中央", kind: "ward", lon: 140.8817, lat: 38.3253, sort_order: 60, transport_fee: 3000 },
  { id: "cccccccc-0000-4000-8000-000000000007", name: "長町", kind: "ward", lon: 140.8860, lat: 38.2249, sort_order: 70, transport_fee: 3000 },
  { id: "cccccccc-0000-4000-8000-000000000008", name: "名取", kind: "city", lon: 140.8912, lat: 38.1717, sort_order: 80, transport_fee: 4000 },
];

/** エリア名 → id（マトリクス定義を読みやすくする） */
const areaId = new Map(areaSeeds.map((a) => [a.name, a.id]));

/**
 * 車のエリア間移動時間マトリクス（分 / 双方向に同値で展開）。
 * 近隣 4〜8分、遠方（名取）30〜35分の差をつける（spec 18章の現実的分布）。
 * 未登録ペア（例: 泉中央↔名取）は暫定値経路（provisionalCarMinutes）のデモに残す。
 */
const carMatrixSeeds: { from: string; to: string; minutes: number }[] = [
  { from: "国分町", to: "一番町", minutes: 4 },
  { from: "国分町", to: "仙台駅前", minutes: 8 },
  { from: "国分町", to: "仙台市中心部", minutes: 5 },
  { from: "国分町", to: "仙台市内", minutes: 7 },
  { from: "一番町", to: "仙台駅前", minutes: 7 },
  { from: "仙台駅前", to: "仙台市中心部", minutes: 6 },
  { from: "仙台市中心部", to: "仙台市内", minutes: 6 },
  { from: "国分町", to: "泉中央", minutes: 25 },
  { from: "仙台駅前", to: "泉中央", minutes: 25 },
  { from: "国分町", to: "長町", minutes: 18 },
  { from: "仙台駅前", to: "長町", minutes: 14 },
  { from: "仙台駅前", to: "名取", minutes: 30 },
  { from: "国分町", to: "名取", minutes: 35 },
  { from: "長町", to: "名取", minutes: 15 },
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
  { id: "dddddddd-0000-4000-8000-000000000001", name: "事務所（国分町）", kind: "office", lon: 140.8712, lat: 38.2635 },
  { id: "dddddddd-0000-4000-8000-000000000002", name: "仙台駅 待機", kind: "station", lon: 140.8820, lat: 38.2600 },
  { id: "dddddddd-0000-4000-8000-000000000003", name: "自宅待機（長町）", kind: "home", lon: 140.8860, lat: 38.2250 },
];

/**
 * 移動バッファ（spec 5-2）。既定: 到着前10・駐車15・施術前5・施術後10。
 * 中心部（国分町）は駐車バッファ20分に上書き（エリア別上書きの実証）。
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
    area: "国分町",
    arrive_min: 10,
    parking_min: 20,
    before_min: 5,
    after_min: 10,
  },
];

/** 徒歩上書きの例（spec 5-1: 川・線路等の分断区間は迂回係数が効かない） */
const walkOverrideSeeds: { from: string; to: string; added_minutes: number; note: string }[] = [
  {
    from: "国分町",
    to: "一番町",
    added_minutes: 4,
    note: "定禅寺通り・アーケードを渡るため直線距離より時間がかかる区間",
  },
];

// ---------------------------------------------------------------------------
// フェーズ7: コース・オプション・ホテル（spec 18-1・18-2・8-2 / 冪等）
// すべて仮の値（DB への初期投入）。CMS から変更できることをもって完成とする
// （spec 18章: コードにハードコードで埋め込んだら不合格）。
// ---------------------------------------------------------------------------

/** コース（spec 18-1）。金額は整数（円）。指名料既定は spec 18-3 の通常指名 ¥1,000 */
const courseSeeds: {
  id: string;
  name: string;
  duration_min: number;
  price: number;
  nomination_fee_default: number;
  sort_order: number;
}[] = [
  { id: "99999999-0000-4000-8000-000000000001", name: "ショート", duration_min: 60, price: 12000, nomination_fee_default: 1000, sort_order: 10 },
  { id: "99999999-0000-4000-8000-000000000002", name: "スタンダード", duration_min: 90, price: 17000, nomination_fee_default: 1000, sort_order: 20 },
  { id: "99999999-0000-4000-8000-000000000003", name: "ロング", duration_min: 120, price: 22000, nomination_fee_default: 1000, sort_order: 30 },
  { id: "99999999-0000-4000-8000-000000000004", name: "スペシャル", duration_min: 150, price: 27000, nomination_fee_default: 1000, sort_order: 40 },
];

/**
 * オプション（spec 18-2）。duration_min が空き枠計算の L に効く（spec 3-4・5-3）。
 * バックは spec 18-4 のオプション既定 50% を rate で。延長はランク別レート（フェーズ18）
 * の対象なのでここでは 55% を仮置き。アロマは固定額バックの例（fixed ¥1,000）として
 * back_type の両値をシードでデモする。
 */
const optionSeeds: {
  id: string;
  name: string;
  description: string;
  price: number;
  duration_min: number;
  back_type: "fixed" | "rate";
  back_value: number;
  sort_order: number;
}[] = [
  {
    id: "88888888-0000-4000-8000-000000000001",
    name: "延長30分",
    description: "コース終了後に30分延長します。",
    price: 6000,
    duration_min: 30,
    back_type: "rate",
    back_value: 55,
    sort_order: 10,
  },
  {
    id: "88888888-0000-4000-8000-000000000002",
    name: "延長60分",
    description: "コース終了後に60分延長します。",
    price: 11000,
    duration_min: 60,
    back_type: "rate",
    back_value: 55,
    sort_order: 20,
  },
  {
    id: "88888888-0000-4000-8000-000000000003",
    name: "アロマオイル",
    description: "お好みの香りのアロマオイルを使用します（時間は変わりません）。",
    price: 2000,
    duration_min: 0,
    back_type: "fixed",
    back_value: 1000,
    sort_order: 30,
  },
  {
    id: "88888888-0000-4000-8000-000000000004",
    name: "ヘッドケア",
    description: "頭部の重点ケアを15分追加します。",
    price: 2500,
    duration_min: 15,
    back_type: "rate",
    back_value: 50,
    sort_order: 40,
  },
  {
    id: "88888888-0000-4000-8000-000000000005",
    name: "フットケア",
    description: "足元の重点ケアを15分追加します。",
    price: 2500,
    duration_min: 15,
    back_type: "rate",
    back_value: 50,
    sort_order: 50,
  },
];

/**
 * オプションの対応セラピスト（spec 3-4: 行が無ければ全員対応）。
 * フットケアだけ「あおい」限定にして、絞り込みの仕組みをシードでデモする。
 * 他のオプションは行なし = 全員対応。
 */
const optionAvailabilitySeeds: { option: string; therapistSlug: string }[] = [
  { option: "フットケア", therapistSlug: "aoi" },
];

/**
 * ホテルマスタ（spec 8-2）。extra_minutes = 到着から部屋までの追加時間（分）。
 * - 大型ホテル（extra 12分）: 完了条件「館内移動時間が加算される」の実データ
 * - is_blocked の例: 予約を作らせない・公開側で選べない施設
 * - 仮登録の例: 電話中に名前だけ登録し後から補完する運用（area/location null）
 */
const hotelSeeds: {
  id: string;
  name: string;
  name_kana: string | null;
  address: string | null;
  area: string | null;
  lon: number | null;
  lat: number | null;
  entry_note: string | null;
  parking_note: string | null;
  extra_minutes: number;
  is_blocked: boolean;
  note: string | null;
}[] = [
  {
    id: "77777777-0000-4000-8000-000000000001",
    name: "仙台グランドタワーホテル",
    name_kana: "せんだいぐらんどたわーほてる",
    address: "仙台市青葉区中央0-0-0",
    area: "仙台駅前",
    lon: 140.8825,
    lat: 38.2605,
    entry_note: "フロント経由が必要。内線で来訪者確認あり",
    parking_note: "地下駐車場あり（30分無料・以降有料）。入口からエレベーターまで遠い",
    extra_minutes: 12,
    is_blocked: false,
    note: "大型ホテル。エントランスから部屋まで時間がかかる",
  },
  {
    id: "77777777-0000-4000-8000-000000000002",
    name: "国分町ステイイン",
    name_kana: "こくぶんちょうすているん",
    address: "仙台市青葉区国分町0-0-0",
    area: "国分町",
    lon: 140.8712,
    lat: 38.2638,
    entry_note: "直接部屋へ可",
    parking_note: "駐車場なし。近隣コインパーキング利用",
    extra_minutes: 3,
    is_blocked: false,
    note: null,
  },
  {
    id: "77777777-0000-4000-8000-000000000003",
    name: "一番町パークホテル",
    name_kana: "いちばんちょうぱーくほてる",
    address: "仙台市青葉区一番町0-0-0",
    area: "一番町",
    lon: 140.8720,
    lat: 38.2612,
    entry_note: "フロント経由が必要",
    parking_note: "提携駐車場あり（徒歩2分）",
    extra_minutes: 5,
    is_blocked: false,
    note: null,
  },
  {
    id: "77777777-0000-4000-8000-000000000004",
    name: "ホテルノワール長町",
    name_kana: "ほてるのわーるながまち",
    address: "仙台市太白区長町0-0-0",
    area: "長町",
    lon: 140.8862,
    lat: 38.2252,
    entry_note: null,
    parking_note: null,
    extra_minutes: 5,
    is_blocked: true,
    note: "過去のトラブルにより入館お断り（spec 8-2 is_blocked のデモ）",
  },
  {
    id: "77777777-0000-4000-8000-000000000005",
    name: "（仮登録）泉中央ビジネスホテル",
    name_kana: null,
    address: null,
    area: null,
    lon: null,
    lat: null,
    entry_note: null,
    parking_note: null,
    extra_minutes: 0,
    is_blocked: false,
    note: "電話中の仮登録デモ。後から住所・エリア・館内移動時間を補完する（spec 8-2）",
  },
];

// ---------------------------------------------------------------------------
// フェーズ8: 出勤予定（spec 3-3・4章・14章 #8 / 冪等）
//
// 完了条件「エリアで絞れる」を実データで再現する配置:
// - aoi（published・徒歩派）: 国分町・一番町・仙台駅前だけ対応。
//   **国分町は対応するが名取は対応しない** → /schedule?area=名取 で消える
// - ren（published・車で全域）: 全エリア対応。名取で絞っても出る。
//   +2日目は当日欠勤（is_day_off）の例 → その日は一覧から消える
// - minato（active だが未公開）: 出勤していても published が無いので公開出勤表に出ない
// 日付は常に「シード実行日（Asia/Tokyo）から5日分」の相対で入れる（いつ流してもデモが生きる）。
// ---------------------------------------------------------------------------

/** シードの基準日（Asia/Tokyo の今日） */
const seedToday = localDateISO(new Date());

const shiftSeeds: {
  slug: string;
  dayOffset: number;
  start: string;
  end: string;
  /** bases.name（null なら未設定） */
  baseStart: string | null;
  baseEnd: string | null;
  maxBookings: number | null;
  /** areas.name の配列。"all" は全エリア */
  areas: string[] | "all";
  isDayOff: boolean;
  note: string | null;
}[] = [
  // aoi: 徒歩圏に濃く（国分町・一番町・仙台駅前 / spec 5-1「狭い範囲に濃く」）
  ...[0, 1, 2, 3, 4].map((dayOffset) => ({
    slug: "aoi",
    dayOffset,
    start: "10:00",
    end: "19:00",
    baseStart: "事務所（国分町）",
    baseEnd: "事務所（国分町）",
    maxBookings: 3,
    areas: ["国分町", "一番町", "仙台駅前"] as string[] | "all",
    isDayOff: false,
    note: null,
  })),
  // ren: 車で全域・上限なし。+2日目は当日欠勤の例
  ...[0, 1, 2, 3, 4].map((dayOffset) => ({
    slug: "ren",
    dayOffset,
    start: "12:00",
    end: "22:00",
    baseStart: "仙台駅 待機",
    baseEnd: "仙台駅 待機",
    maxBookings: null,
    areas: "all" as string[] | "all",
    isDayOff: dayOffset === 2,
    note: dayOffset === 2 ? "当日欠勤の例（ワンタップ「本日休み」/ spec 3-3）" : null,
  })),
  // minato: 出勤はあるが published が無い → 公開出勤表に出ないデモ
  ...[0, 1, 2].map((dayOffset) => ({
    slug: "minato",
    dayOffset,
    start: "17:00",
    end: "23:30",
    baseStart: "自宅待機（長町）",
    baseEnd: "自宅待機（長町）",
    maxBookings: 2,
    areas: ["長町", "仙台市内"] as string[] | "all",
    isDayOff: false,
    note: null,
  })),
];

// ---------------------------------------------------------------------------
// フェーズ18: セラピストランク・報酬レート（spec 18-4・18-5 / 冪等）
// ---------------------------------------------------------------------------

const therapistRankSeeds: { id: string; name: string; sortOrder: number }[] = [
  { id: "f1f1f1f1-0000-4000-8000-000000000001", name: "プレミア", sortOrder: 10 },
  { id: "f1f1f1f1-0000-4000-8000-000000000002", name: "レギュラー", sortOrder: 20 },
  { id: "f1f1f1f1-0000-4000-8000-000000000003", name: "新人", sortOrder: 30 },
];

const therapistRankAssignments: { slug: string; rankName: string }[] = [
  { slug: "aoi",    rankName: "プレミア" },
  { slug: "ren",    rankName: "レギュラー" },
  { slug: "minato", rankName: "新人" },
  { slug: "hinata", rankName: "新人" }, // 退職済だが履歴データ用に割当
];

type PayoutRateSeed = {
  id: string;
  /** 直接指定する therapist UUID。null の場合は therapistSlug から解決する */
  therapistId: string | null;
  /** slug で解決する個別特例。therapistId が null のとき使う */
  therapistSlug?: string;
  rankId: string | null;
  targetType: "course" | "option" | "nomination" | "transport" | "late_night" | "cancel_fee";
  calcType: "fixed" | "rate";
  value: number;
  effectiveFrom: string;
  note: string | null;
};

const payoutRateSeeds: PayoutRateSeed[] = [
  // ---- 新人ランク (f1f1f1f1-0000-4000-8000-000000000003) ----
  {
    id: "a1a1a1a1-0001-4000-8000-000000000001",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000003",
    targetType: "course",
    calcType: "rate",
    value: 50,
    effectiveFrom: "2026-01-01",
    note: null,
  },
  {
    id: "a1a1a1a1-0002-4000-8000-000000000001",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000003",
    targetType: "option",
    calcType: "rate",
    value: 50,
    effectiveFrom: "2026-01-01",
    note: null,
  },
  {
    id: "a1a1a1a1-0003-4000-8000-000000000001",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000003",
    targetType: "nomination",
    calcType: "rate",
    value: 100,
    effectiveFrom: "2026-01-01",
    note: "指名料は全額バック",
  },
  {
    id: "a1a1a1a1-0004-4000-8000-000000000001",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000003",
    targetType: "transport",
    calcType: "rate",
    value: 100,
    effectiveFrom: "2026-01-01",
    note: "交通費は全額バック",
  },
  {
    id: "a1a1a1a1-0005-4000-8000-000000000001",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000003",
    targetType: "late_night",
    calcType: "rate",
    value: 50,
    effectiveFrom: "2026-01-01",
    note: null,
  },
  {
    id: "a1a1a1a1-0006-4000-8000-000000000001",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000003",
    targetType: "cancel_fee",
    calcType: "rate",
    value: 0,
    effectiveFrom: "2026-01-01",
    note: "キャンセル料はバックなし",
  },
  // ---- レギュラーランク (f1f1f1f1-0000-4000-8000-000000000002) ----
  {
    id: "a1a1a1a1-0001-4000-8000-000000000002",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000002",
    targetType: "course",
    calcType: "rate",
    value: 55,
    effectiveFrom: "2026-01-01",
    note: null,
  },
  {
    id: "a1a1a1a1-0002-4000-8000-000000000002",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000002",
    targetType: "option",
    calcType: "rate",
    value: 55,
    effectiveFrom: "2026-01-01",
    note: null,
  },
  {
    id: "a1a1a1a1-0003-4000-8000-000000000002",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000002",
    targetType: "nomination",
    calcType: "rate",
    value: 100,
    effectiveFrom: "2026-01-01",
    note: "指名料は全額バック",
  },
  {
    id: "a1a1a1a1-0004-4000-8000-000000000002",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000002",
    targetType: "transport",
    calcType: "rate",
    value: 100,
    effectiveFrom: "2026-01-01",
    note: "交通費は全額バック",
  },
  {
    id: "a1a1a1a1-0005-4000-8000-000000000002",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000002",
    targetType: "late_night",
    calcType: "rate",
    value: 55,
    effectiveFrom: "2026-01-01",
    note: null,
  },
  {
    id: "a1a1a1a1-0006-4000-8000-000000000002",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000002",
    targetType: "cancel_fee",
    calcType: "rate",
    value: 0,
    effectiveFrom: "2026-01-01",
    note: "キャンセル料はバックなし",
  },
  // ---- プレミアランク (f1f1f1f1-0000-4000-8000-000000000001) ----
  {
    id: "a1a1a1a1-0001-4000-8000-000000000003",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000001",
    targetType: "course",
    calcType: "rate",
    value: 65,
    effectiveFrom: "2026-01-01",
    note: null,
  },
  {
    id: "a1a1a1a1-0002-4000-8000-000000000003",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000001",
    targetType: "option",
    calcType: "rate",
    value: 65,
    effectiveFrom: "2026-01-01",
    note: null,
  },
  {
    id: "a1a1a1a1-0003-4000-8000-000000000003",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000001",
    targetType: "nomination",
    calcType: "rate",
    value: 100,
    effectiveFrom: "2026-01-01",
    note: "指名料は全額バック",
  },
  {
    id: "a1a1a1a1-0004-4000-8000-000000000003",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000001",
    targetType: "transport",
    calcType: "rate",
    value: 100,
    effectiveFrom: "2026-01-01",
    note: "交通費は全額バック",
  },
  {
    id: "a1a1a1a1-0005-4000-8000-000000000003",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000001",
    targetType: "late_night",
    calcType: "rate",
    value: 65,
    effectiveFrom: "2026-01-01",
    note: null,
  },
  {
    id: "a1a1a1a1-0006-4000-8000-000000000003",
    therapistId: null,
    rankId: "f1f1f1f1-0000-4000-8000-000000000001",
    targetType: "cancel_fee",
    calcType: "rate",
    value: 0,
    effectiveFrom: "2026-01-01",
    note: "キャンセル料はバックなし",
  },
  // ---- 個別特例 (spec 18-5) ----
  // aoi: コースのバック率を70%に（交渉済み特例）
  {
    id: "a1a1a1a1-0101-4000-8000-000000000001",
    therapistId: null,
    therapistSlug: "aoi",
    rankId: null,
    targetType: "course",
    calcType: "rate",
    value: 70,
    effectiveFrom: "2026-03-01",
    note: "特例: アオイは交渉済みで70%",
  },
  // minato: 交通費を上限500円固定
  {
    id: "a1a1a1a1-0102-4000-8000-000000000001",
    therapistId: null,
    therapistSlug: "minato",
    rankId: null,
    targetType: "transport",
    calcType: "fixed",
    value: 500,
    effectiveFrom: "2026-01-01",
    note: "特例: 交通費は上限500円固定",
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
          url          = excluded.url,
          alt          = excluded.alt,
          consent_flag = excluded.consent_flag,
          consent_date = excluded.consent_date,
          tags         = excluded.tags,
          face_visibility = excluded.face_visibility,
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

    // app_users の therapist_id を therapists.id に紐付け（マイページ dev なりすまし用）。
    // therapist ロールの app_user が既に upsert 済みであること・therapists の upsert が先行すること。
    // therapist_id is null の行のみ更新（冪等）。
    for (const [appUserId, therapistSlug] of [
      ["aaaaaaaa-0000-4000-8000-000000000004", "aoi"],
      ["aaaaaaaa-0000-4000-8000-000000000005", "ren"],
    ] as const) {
      await sql`
        update app_users
        set therapist_id = (select id from therapists where slug = ${therapistSlug}),
            updated_at   = now()
        where id = ${appUserId}::uuid
          and therapist_id is null
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
    for (const slug of ["aoi", "hinata", "ren"]) {
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
        insert into areas (id, name, kind, center, sort_order, is_active, transport_fee)
        values (
          ${a.id}::uuid, ${a.name}, ${a.kind},
          st_setsrid(st_makepoint(${a.lon}::float8, ${a.lat}::float8), 4326)::geography,
          ${a.sort_order}, true, ${a.transport_fee}
        )
        on conflict (id) do update set
          name         = excluded.name,
          kind         = excluded.kind,
          center       = excluded.center,
          sort_order   = excluded.sort_order,
          is_active    = excluded.is_active,
          transport_fee = excluded.transport_fee
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

    // -----------------------------------------------------------------------
    // フェーズ7: コース・オプション・ホテル（冪等）
    // -----------------------------------------------------------------------

    for (const c of courseSeeds) {
      await sql`
        insert into courses (id, name, duration_min, price, nomination_fee_default, sort_order, is_active)
        values (
          ${c.id}::uuid, ${c.name}, ${c.duration_min}, ${c.price},
          ${c.nomination_fee_default}, ${c.sort_order}, true
        )
        on conflict (id) do update set
          name                   = excluded.name,
          duration_min           = excluded.duration_min,
          price                  = excluded.price,
          nomination_fee_default = excluded.nomination_fee_default,
          sort_order             = excluded.sort_order
      `;
    }

    for (const o of optionSeeds) {
      await sql`
        insert into options
          (id, name, description, price, duration_min, back_type, back_value, is_public, sort_order, is_active)
        values (
          ${o.id}::uuid, ${o.name}, ${o.description}, ${o.price}, ${o.duration_min},
          ${o.back_type}::option_back_type, ${o.back_value}, true, ${o.sort_order}, true
        )
        on conflict (id) do update set
          name         = excluded.name,
          description  = excluded.description,
          price        = excluded.price,
          duration_min = excluded.duration_min,
          back_type    = excluded.back_type,
          back_value   = excluded.back_value,
          sort_order   = excluded.sort_order
      `;
    }

    // オプション対応セラピスト（therapists.slug で引く。行が無ければ全員対応）
    const optionIdByName = new Map(optionSeeds.map((o) => [o.name, o.id]));
    for (const oa of optionAvailabilitySeeds) {
      const optionId = optionIdByName.get(oa.option);
      if (!optionId) throw new Error(`オプション名が不正: ${oa.option}`);
      await sql`
        insert into option_availability (option_id, therapist_id)
        select ${optionId}::uuid, t.id from therapists t where t.slug = ${oa.therapistSlug}
        on conflict (option_id, therapist_id) do nothing
      `;
    }

    for (const h of hotelSeeds) {
      const hotelAreaId = h.area === null ? null : (areaId.get(h.area) ?? null);
      if (h.area !== null && hotelAreaId === null) {
        throw new Error(`ホテルのエリア名が不正: ${h.area}`);
      }
      await sql`
        insert into hotels
          (id, name, name_kana, address, location, area_id,
           entry_note, parking_note, extra_minutes, is_blocked, note)
        values (
          ${h.id}::uuid, ${h.name}, ${h.name_kana}, ${h.address},
          ${
            h.lon !== null && h.lat !== null
              ? sql`st_setsrid(st_makepoint(${h.lon}::float8, ${h.lat}::float8), 4326)::geography`
              : null
          },
          ${hotelAreaId}::uuid,
          ${h.entry_note}, ${h.parking_note}, ${h.extra_minutes}, ${h.is_blocked}, ${h.note}
        )
        on conflict (id) do update set
          name          = excluded.name,
          name_kana     = excluded.name_kana,
          address       = excluded.address,
          location      = excluded.location,
          area_id       = excluded.area_id,
          entry_note    = excluded.entry_note,
          parking_note  = excluded.parking_note,
          extra_minutes = excluded.extra_minutes,
          is_blocked    = excluded.is_blocked,
          note          = excluded.note
      `;
    }

    // -----------------------------------------------------------------------
    // フェーズ8: 出勤予定（shifts + shift_areas）と個人の移動設定（冪等）
    // -----------------------------------------------------------------------

    // セラピスト個人の移動設定（spec 5-1「セラピストごとの設定」）:
    // aoi は車を使えない（徒歩圏の予約のみ / chooseMode → unreachable のデモ）。
    // ren は車可（既定 true のまま）。walk_cap_meters は null = walk_settings の既定。
    await sql`update therapists set can_use_car = false where slug = 'aoi'`;

    // ダミー therapist アカウントを aoi に紐付ける（RLS「自分の shift のみ」の実証用。
    // spec 17章のテストアカウント / 0007 の shifts_self_* ポリシーが参照する）。
    await sql`
      update app_users
      set therapist_id = (select id from therapists where slug = 'aoi')
      where id = ${"aaaaaaaa-0000-4000-8000-000000000004"}::uuid
        and role = 'therapist'
    `;

    for (const s of shiftSeeds) {
      const workDate = addDaysISO(seedToday, s.dayOffset);
      const { startAt, endAt } = shiftInstants(workDate, s.start, s.end);
      const baseStartId = s.baseStart === null ? null : baseSeeds.find((b) => b.name === s.baseStart)?.id;
      const baseEndId = s.baseEnd === null ? null : baseSeeds.find((b) => b.name === s.baseEnd)?.id;
      if (baseStartId === undefined || baseEndId === undefined) {
        throw new Error(`シフトの待機場所名が不正: ${s.baseStart} / ${s.baseEnd}`);
      }

      const rows = await sql<{ id: string }[]>`
        insert into shifts
          (therapist_id, work_date, start_at, end_at,
           base_start_id, base_end_id, max_bookings, note, is_day_off)
        select t.id, ${workDate}, ${startAt}, ${endAt},
               ${baseStartId}::uuid, ${baseEndId}::uuid,
               ${s.maxBookings}, ${s.note}, ${s.isDayOff}
        from therapists t where t.slug = ${s.slug}
        on conflict (therapist_id, work_date) do update set
          start_at      = excluded.start_at,
          end_at        = excluded.end_at,
          base_start_id = excluded.base_start_id,
          base_end_id   = excluded.base_end_id,
          max_bookings  = excluded.max_bookings,
          note          = excluded.note,
          is_day_off    = excluded.is_day_off
        returning id
      `;
      const shiftId = rows[0]?.id;
      if (!shiftId) throw new Error(`シフトの投入に失敗: ${s.slug} ${workDate}`);

      // 対応エリアは全置換（冪等。エリア構成を変えたシードの再実行でも一致する）
      await sql`delete from shift_areas where shift_id = ${shiftId}::uuid`;
      const areaNames = s.areas === "all" ? areaSeeds.map((a) => a.name) : s.areas;
      for (const name of areaNames) {
        const id = areaId.get(name);
        if (!id) throw new Error(`シフト対応エリア名が不正: ${name}`);
        await sql`
          insert into shift_areas (shift_id, area_id)
          values (${shiftId}::uuid, ${id}::uuid)
          on conflict do nothing
        `;
      }
    }

    // -----------------------------------------------------------------------
    // フェーズ12: 不成立ログ・電話注文シード（冪等）
    // -----------------------------------------------------------------------

    // Phase 12 seed data: customers for auto-fill demo
    const phase12Customers = [
      {
        phone: '09011111111',
        name: 'デモ 鈴木',
        note: 'お好み: 指圧強め、腰を重点的に',
      },
      {
        phone: '09022222222',
        name: 'デモ 佐藤',
        note: '足つぼが好評でした',
      },
      {
        phone: '09033333333',
        name: 'デモ 田中',
        note: null,
      },
    ];

    for (const c of phase12Customers) {
      const crows = await sql<{ id: string }[]>`
        insert into customers (phone, name, note)
        values (${c.phone}, ${c.name}, ${c.note})
        on conflict (phone) do update
          set name = excluded.name,
              note = coalesce(excluded.note, customers.note)
        returning id
      `;
      const customerId = crows[0]?.id;
      if (!customerId) continue;

      // Insert home address for auto-fill（冪等: 既に home 住所があれば追加しない）
      await sql`
        insert into addresses (customer_id, kind, detail, area_id)
        select ${customerId}::uuid, 'home'::address_kind, '仙台市青葉区国分町〇〇 1-2-3', a.id
        from areas a
        where a.name = '国分町'
          and not exists (
            select 1 from addresses ex
            where ex.customer_id = ${customerId}::uuid and ex.kind = 'home'
          )
        limit 1
      `;
    }

    // -----------------------------------------------------------------------
    // フェーズ12: 予約シード（電話確認ゲートのデモ / 冪等）
    //   - web 予約: phone_confirmed_at = null（未確認 → canGenerateDispatch = false）
    //   - phone 予約: source='phone' + phone_confirmed_at 設定済み（保存時に自動確認）
    // 占有区間（depart_at〜free_at）が exclusion 制約 no_therapist_overlap で重複しない
    // よう、セラピストごとに十分離した時間帯に配置する。冪等性は固定 id で担保。
    // ren（車で全域・上限なし）を予約先に使う。基準日から3日後の日中に置く。
    // -----------------------------------------------------------------------
    const phase12Reservations: {
      id: string;
      customerPhone: string;
      therapistSlug: string;
      source: "web" | "phone";
      phoneConfirmed: boolean;
      /** 基準日からの日数 */
      dayOffset: number;
      /** 施術開始（"HH:mm" / Asia/Tokyo） */
      start: string;
      courseId: string;
    }[] = [
      // web 予約（未確認）: 電話確認待ち = canGenerateDispatch は false
      { id: "12120000-0000-4000-8000-000000000001", customerPhone: "09011111111", therapistSlug: "ren", source: "web", phoneConfirmed: false, dayOffset: 3, start: "13:00", courseId: "99999999-0000-4000-8000-000000000001" },
      { id: "12120000-0000-4000-8000-000000000002", customerPhone: "09022222222", therapistSlug: "ren", source: "web", phoneConfirmed: false, dayOffset: 3, start: "16:00", courseId: "99999999-0000-4000-8000-000000000002" },
      { id: "12120000-0000-4000-8000-000000000003", customerPhone: "09033333333", therapistSlug: "ren", source: "web", phoneConfirmed: false, dayOffset: 3, start: "19:00", courseId: "99999999-0000-4000-8000-000000000001" },
      // phone 予約（確認済み）: source='phone' + phone_confirmed_at 設定済み
      { id: "12120000-0000-4000-8000-000000000004", customerPhone: "09011111111", therapistSlug: "ren", source: "phone", phoneConfirmed: true, dayOffset: 4, start: "13:00", courseId: "99999999-0000-4000-8000-000000000001" },
      { id: "12120000-0000-4000-8000-000000000005", customerPhone: "09022222222", therapistSlug: "ren", source: "phone", phoneConfirmed: true, dayOffset: 4, start: "16:00", courseId: "99999999-0000-4000-8000-000000000002" },
      { id: "12120000-0000-4000-8000-000000000006", customerPhone: "09033333333", therapistSlug: "ren", source: "phone", phoneConfirmed: true, dayOffset: 4, start: "19:00", courseId: "99999999-0000-4000-8000-000000000001" },
    ];

    const kokubunchoAreaId = areaId.get("国分町");
    if (!kokubunchoAreaId) throw new Error("国分町のエリアが見つかりません");

    for (const r of phase12Reservations) {
      const workDate = addDaysISO(seedToday, r.dayOffset);
      const course = courseSeeds.find((c) => c.id === r.courseId);
      if (!course) throw new Error(`予約シードのコースが不正: ${r.courseId}`);
      const { startAt } = shiftInstants(workDate, r.start, r.start);
      const startMs = startAt.getTime();
      const serviceEndAt = new Date(startMs + course.duration_min * 60_000);
      const departAt = new Date(startMs - 25 * 60_000); // 到着バッファ+移動の控え
      const freeAt = new Date(serviceEndAt.getTime() + 10 * 60_000); // 施術後バッファ
      const total = course.price + course.nomination_fee_default;

      await sql`
        insert into reservations (
          id, therapist_id, customer_id, address_id, area_id, course_id,
          start_at, end_at, depart_at, free_at,
          travel_in_min, travel_out_min, buffer_min,
          status, nomination_fee, transport_fee, total_amount,
          source, phone_confirmed_at, phone_confirmed_by
        )
        select
          ${r.id}::uuid, t.id, c.id, a.id, ${kokubunchoAreaId}::uuid, ${r.courseId}::uuid,
          ${startAt}, ${serviceEndAt}, ${departAt}, ${freeAt},
          15, 15, 30,
          'confirmed'::reservation_status, ${course.nomination_fee_default}, 0, ${total},
          ${r.source}::reservation_source,
          ${r.phoneConfirmed ? startAt : null},
          ${r.phoneConfirmed ? "aaaaaaaa-0000-4000-8000-000000000003" : null}::uuid
        from therapists t
        join customers c on c.phone = ${r.customerPhone}
        join addresses a on a.customer_id = c.id and a.kind = 'home'
        where t.slug = ${r.therapistSlug}
        limit 1
        on conflict (id) do nothing
      `;
    }

    // Phase 12: lost_orders seed
    const lostOrderSeeds = [
      { phone: '09011111111', area: '国分町', reason: 'time', note: '20時以降は対応できないとのこと' },
      { phone: '09044444444', area: '石巻市', reason: 'area', note: 'エリア外（石巻）のため案内不可' },
      { phone: null, area: '一番町', reason: 'nomination', note: '指名セラピストが不在' },
      { phone: '09055555555', area: null, reason: 'price', note: '料金が高いとのフィードバック' },
    ] as const;

    for (const lo of lostOrderSeeds) {
      const loAreaId = lo.area === null ? null : (areaId.get(lo.area) ?? null);
      // Check if already exists (idempotent by matching fields)
      const existing = await sql<{ id: string }[]>`
        select id from lost_orders
        where reason = ${lo.reason}::lost_order_reason
          and coalesce(phone, '') = ${lo.phone ?? ''}
          and note = ${lo.note}
        limit 1
      `;
      if (existing.length === 0) {
        await sql`
          insert into lost_orders (phone, area_id, reason, note, created_by)
          values (
            ${lo.phone ?? null},
            ${loAreaId ?? null}::uuid,
            ${lo.reason}::lost_order_reason,
            ${lo.note},
            ${'aaaaaaaa-0000-4000-8000-000000000003'}::uuid
          )
        `;
      }
    }

    // -----------------------------------------------------------------------
    // フェーズ13: 送信テンプレート（spec 8-3 ★）。CMS 編集可の既定2行。
    //   打診用: エリア・時間・コース・バック額のみ。{{場所}}{{部屋番号}}{{顧客名}}
    //           {{電話番号}}{{お好み}} は本文に置かない（受入 L1108）。
    //           万一 CMS で混入しても buildDispatchMessage が構造的に除去する。
    //   確定用: 住所・部屋番号・顧客名・お好みを含む出発直前用（spec 8-3 L788）。
    //           **既定文面に {{電話番号}} は入れない**（spec 7-3 L709: 顧客電話番号を
    //           セラピスト個人端末に残さない。8-3 L788 の確定用列挙にも電話番号は無い）。
    //           発信はマイページのアプリ内発信/転送番号で担う。CMS で明示追加は owner 判断。
    // 冪等: on conflict (kind) do nothing = CMS での編集を上書きしない
    // （初期投入のみ。CMS から変更できることをもって完成 / spec 18章）。
    // -----------------------------------------------------------------------
    const messageTemplateSeeds: { kind: "inquiry" | "confirmed"; name: string; body: string }[] = [
      {
        kind: "inquiry",
        name: "打診用（個人情報なし）",
        body: [
          "【打診】{{日時}}〜",
          "エリア: {{エリア}}",
          "コース: {{コース}}",
          "オプション: {{オプション}}",
          "移動: {{移動手段}}（出発目安 {{出発目安}}）",
          "バック: {{バック額}}",
          "対応可否のご返信をお願いします。",
        ].join("\n"),
      },
      {
        kind: "confirmed",
        name: "確定用（出発直前）",
        body: [
          "【確定】{{日時}}〜 {{セラピスト}}さん",
          "出発目安: {{出発目安}}（{{移動手段}}）",
          "コース: {{コース}}",
          "オプション: {{オプション}}",
          "場所: {{場所}}",
          "部屋番号: {{部屋番号}}",
          "お客様: {{顧客名}}様",
          "お好み: {{お好み}}",
          "合計金額: {{合計金額}}（現地決済）",
          "到着・終了のステータス更新をお願いします。",
        ].join("\n"),
      },
    ];

    for (const t of messageTemplateSeeds) {
      await sql`
        insert into message_templates (kind, name, body)
        values (${t.kind}::template_kind, ${t.name}, ${t.body})
        on conflict (kind) do nothing
      `;
    }

    // -----------------------------------------------------------------------
    // フェーズ18: セラピストランク・報酬レート（spec 18-4・18-5 / 冪等）
    // -----------------------------------------------------------------------
    // therapist_ranks はマイグレーション 0016 が固定UUIDで既に投入済み。
    // seed 側は名前で衝突させず（migration の行を正とする）、以降は名前→id を DB から引く。
    for (const rank of therapistRankSeeds) {
      await sql`
        insert into therapist_ranks (id, name, sort_order)
        values (${rank.id}::uuid, ${rank.name}, ${rank.sortOrder})
        on conflict (name) do nothing
      `;
    }
    // 実際に有効なランクの id を名前で解決（migration/seed どちらの UUID でも吸収）
    const dbRanks = await sql<{ id: string; name: string }[]>`
      select id, name from therapist_ranks
    `;
    const rankIdByName = new Map(dbRanks.map((r) => [r.name, r.id]));
    const rankNameBySeedId = new Map(
      therapistRankSeeds.map((r) => [r.id, r.name]),
    );

    for (const { slug, rankName } of therapistRankAssignments) {
      await sql`
        update therapists
        set rank_id = (select id from therapist_ranks where name = ${rankName})
        where slug = ${slug}
      `;
    }

    for (const rate of payoutRateSeeds) {
      // 個別特例: therapistSlug が指定されている場合は slug から UUID を解決する
      let therapistId = rate.therapistId ?? null;
      if (therapistId === null && rate.therapistSlug) {
        const rows = await sql<{ id: string }[]>`
          select id from therapists where slug = ${rate.therapistSlug} limit 1
        `;
        therapistId = rows[0]?.id ?? null;
      }
      // rank_id は seed の f1f1f1f1 UUID ではなく、名前経由で実DBの id に解決する
      const resolvedRankId = rate.rankId
        ? rankIdByName.get(rankNameBySeedId.get(rate.rankId) ?? "") ?? null
        : null;
      await sql`
        insert into payout_rates
          (id, therapist_id, rank_id, target_type, target_id, calc_type, value, effective_from, note)
        values (
          ${rate.id}::uuid,
          ${therapistId},
          ${resolvedRankId},
          ${rate.targetType}::payout_target_type,
          null,
          ${rate.calcType}::payout_calc_type,
          ${rate.value},
          ${rate.effectiveFrom}::date,
          ${rate.note ?? null}
        )
        on conflict (id) do update set
          value          = excluded.value,
          effective_from = excluded.effective_from,
          note           = excluded.note
      `;
    }

    console.log(
      `シード完了: terminology ${terminology.length} / site_settings ${siteSettings.length} / field_definitions ${fieldDefinitions.length} / app_users ${appUsers.length} / entity_records ${entityRecordSamples.length} / pages ${pageSeeds.length} / media ${mediaSeeds.length} / banned_words ${bannedWordSeeds.length} / therapists ${therapistSeeds.length} / areas ${areaSeeds.length} / area_travel_times ${carMatrixSeeds.length * 2} / travel_time_modifiers ${timeModifierSeeds.length} / bases ${baseSeeds.length} / travel_buffers ${travelBufferSeeds.length} / courses ${courseSeeds.length} / options ${optionSeeds.length} / option_availability ${optionAvailabilitySeeds.length} / hotels ${hotelSeeds.length} / shifts ${shiftSeeds.length}（基準日 ${seedToday} から5日分）/ phase12_customers ${phase12Customers.length} / phase12_reservations ${phase12Reservations.length} / lost_orders ${lostOrderSeeds.length} / message_templates ${messageTemplateSeeds.length} / therapist_ranks ${therapistRankSeeds.length} / therapist_rank_assignments ${therapistRankAssignments.length} / payout_rates ${payoutRateSeeds.length}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((e) => {
  console.error("シード失敗:", e);
  process.exit(1);
});
