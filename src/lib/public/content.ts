import "server-only";
import { getAllSiteSettings } from "@/lib/cms/site-settings-actions";
import { getAllTerminology } from "@/lib/cms/terminology-actions";
import { getPage } from "@/lib/cms/pages-actions";
import { getFieldDefinitions } from "@/lib/cms/get-field-definitions";
import type { FieldDefinition } from "@/domain/cms";
import type { Block } from "@/domain/cms/blocks";

/**
 * 公開側の文言解決レイヤ（spec 3-6 / 13-1）。
 *
 * 公開側コンポーネントは**日本語の文字列リテラルを持たない**。見出し・ナビ・
 * ボタン・プレースホルダはすべてこの層が site_settings / terminology / pages
 * （published）から解決した値を渡す。ここに無いキーはフォールバックとして
 * 空文字またはロケール非依存の記号（英数字）を返す（日本語をハードコードしない）。
 *
 * - 屋号/電話/SNS/ナビ/フッター = site_settings
 * - 施術/担当者/回の呼称 = terminology（service_noun / staff_noun / session_noun）
 * - ページ見出し/リード/ブロック = pages(published)
 */

/** site_settings のうち文字列で取り出したいキーの値（無ければ ""） */
function str(settings: Record<string, unknown>, key: string): string {
  const v = settings[key];
  return typeof v === "string" ? v : "";
}

/** ナビゲーション項目（site_settings.nav_items / terminology 参照キー付き） */
export interface NavItem {
  href: string;
  /** 表示ラベル（settings 由来。無ければ空） */
  label: string;
}

/** site_settings.nav_items は [{href,label}] を想定。壊れていれば空配列 */
function parseNavItems(settings: Record<string, unknown>): NavItem[] {
  const raw = settings["nav_items"];
  if (!Array.isArray(raw)) return [];
  const out: NavItem[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      "href" in item &&
      "label" in item &&
      typeof (item as { href: unknown }).href === "string" &&
      typeof (item as { label: unknown }).label === "string"
    ) {
      out.push({
        href: (item as { href: string }).href,
        label: (item as { label: string }).label,
      });
    }
  }
  return out;
}

/** SNS リンク（site_settings.social_links） */
export interface SocialLink {
  label: string;
  href: string;
}

function parseSocialLinks(settings: Record<string, unknown>): SocialLink[] {
  const raw = settings["social_links"];
  if (!Array.isArray(raw)) return [];
  const out: SocialLink[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      "href" in item &&
      "label" in item &&
      typeof (item as { href: unknown }).href === "string" &&
      typeof (item as { label: unknown }).label === "string"
    ) {
      out.push({
        href: (item as { href: string }).href,
        label: (item as { label: string }).label,
      });
    }
  }
  return out;
}

/**
 * サイト全体の解決済みコンテキスト。全公開ページのレイアウトが受け取る。
 * すべての文言は CMS/用語辞書由来。コンポーネントはこの値だけを描画する。
 */
export interface SiteContext {
  brandName: string;
  receptionPhone: string;
  receptionHours: string;
  footerNote: string;
  legalNote: string;
  nav: NavItem[];
  social: SocialLink[];
  /** 用語辞書（service_noun / staff_noun / session_noun など） */
  terms: Record<string, string>;
  /** UI 文言（settings.ui_labels 経由。ボタン/空状態など。無ければ空文字） */
  labels: Record<string, string>;
}

/** settings.ui_labels（{key:value} の辞書）を安全に取り出す */
function parseLabels(settings: Record<string, unknown>): Record<string, string> {
  const raw = settings["ui_labels"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * ラベルを引く。settings.ui_labels → terminology の順で探し、無ければ空文字。
 * 日本語のハードコードを避けるため、フォールバックは空文字のみ。
 */
export function label(ctx: SiteContext, key: string): string {
  return ctx.labels[key] ?? ctx.terms[key] ?? "";
}

/** サイト共通コンテキストを解決する（レイアウトで1回） */
export async function getSiteContext(locale = "ja"): Promise<SiteContext> {
  const [settings, terms] = await Promise.all([
    getAllSiteSettings(),
    getAllTerminology(locale),
  ]);
  return {
    brandName: str(settings, "brand_name"),
    receptionPhone: str(settings, "reception_phone"),
    receptionHours: str(settings, "reception_hours"),
    footerNote: str(settings, "footer_note"),
    legalNote: str(settings, "legal_note"),
    nav: parseNavItems(settings),
    social: parseSocialLinks(settings),
    terms,
    labels: parseLabels(settings),
  };
}

/**
 * 固定ページの published コンテンツ。未公開なら fields は空、blocks は空配列。
 * draft は決して返さない（spec 2章: 読み取りは published のみ）。
 */
export interface PublishedPage {
  slug: string;
  heading: string;
  lead: string;
  seoTitle: string;
  seoDescription: string;
  blocks: Block[];
  /** published_at が非 null なら公開済み */
  isPublished: boolean;
}

function pageStr(fields: Record<string, unknown> | null, key: string): string {
  if (!fields) return "";
  const v = fields[key];
  return typeof v === "string" ? v : "";
}

/**
 * published のページを取得する。未公開時は空のプレースホルダ（空状態）を返す。
 */
export async function getPublishedPage(slug: string, locale = "ja"): Promise<PublishedPage> {
  const page = await getPage(slug, locale);
  const publishedFields = page?.publishedFields ?? null;
  const publishedBlocks = page?.publishedBlocks ?? null;
  const isPublished = Boolean(page?.publishedAt) && publishedBlocks !== null;
  return {
    slug,
    heading: pageStr(publishedFields, "heading"),
    lead: pageStr(publishedFields, "lead"),
    seoTitle: pageStr(publishedFields, "seoTitle"),
    seoDescription: pageStr(publishedFields, "seoDescription"),
    blocks: (publishedBlocks ?? []).filter((b) => b.visible),
    isPublished,
  };
}

/** 公開表示に使う therapist フィールド定義（is_public のみ・sort_order 順） */
export async function getPublicTherapistFields(): Promise<FieldDefinition[]> {
  const defs = await getFieldDefinitions("therapist");
  return defs.filter((d) => d.isPublic && d.deletedAt === null);
}
