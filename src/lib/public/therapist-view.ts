import "server-only";
import type { FieldDefinition } from "@/domain/cms";
import type { PublicTherapist, PublicMedia } from "@/lib/public/queries";
import { getPublicMediaMap } from "@/lib/public/queries";

/**
 * 公開セラピストの表示モデル（field_definitions 駆動 / spec 2-2）。
 *
 * entity_records.published の生の JSONB を、is_public な field_definitions の
 * 並び（sort_order）に沿って「表示可能な項目」へ写す。日本語の見出しは
 * field_definitions.label（CMS 由来）であり、コンポーネントに直書きしない。
 */

/** 表示する1項目（画像以外の汎用フィールド） */
export interface DisplayField {
  key: string;
  /** CMS 由来のラベル（field_definitions.label） */
  label: string;
  type: FieldDefinition["type"];
  groupLabel: string | null;
  /** 表示用に整形済みの値 */
  value: DisplayValue;
}

export type DisplayValue =
  | { kind: "text"; text: string }
  | { kind: "html"; html: string }
  | { kind: "number"; num: number }
  | { kind: "boolean"; bool: boolean }
  | { kind: "tags"; tags: string[] }
  | { kind: "url"; url: string }
  | { kind: "money"; amount: number };

/** セラピスト個人ページ用の完全な表示モデル */
export interface TherapistView {
  slug: string;
  /** 写真（公開可能なもののみ・順序保持） */
  photos: PublicMedia[];
  /** 氏名・芸名（name フィールドがあれば / JSON-LD Person.name 用） */
  name: string;
  /** キャッチコピー（catch_copy フィールドがあれば） */
  catchCopy: string;
  /** 得意な施術タグ（good_at 等 filterable な multi_select/tag の統合） */
  goodAtTags: string[];
  /** is_public 順に並んだ表示フィールド（画像フィールドを除く） */
  fields: DisplayField[];
}

/** image / image_gallery フィールドの値から media id 群を取り出す */
function extractIds(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  return [];
}

/** 汎用フィールドを表示値へ整形する */
function toDisplayValue(def: FieldDefinition, raw: unknown): DisplayValue | null {
  switch (def.type) {
    case "text":
    case "textarea":
    case "select":
    case "date":
      if (typeof raw === "string" && raw.length > 0) return { kind: "text", text: raw };
      return null;
    case "rich_text":
      if (typeof raw === "string" && raw.length > 0) return { kind: "html", html: raw };
      return null;
    case "number":
      if (typeof raw === "number") return { kind: "number", num: raw };
      return null;
    case "money":
      if (typeof raw === "number") return { kind: "money", amount: raw };
      return null;
    case "boolean":
      if (typeof raw === "boolean") return { kind: "boolean", bool: raw };
      return null;
    case "multi_select":
    case "tag": {
      const tags = Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
      return tags.length > 0 ? { kind: "tags", tags } : null;
    }
    case "url":
      if (typeof raw === "string" && raw.length > 0) return { kind: "url", url: raw };
      return null;
    default:
      return null;
  }
}

/**
 * 公開セラピスト + is_public フィールド定義から表示モデルを組む。
 * media は公開可能なもの（consent 済み・非表示でない）だけを解決する。
 */
export async function buildTherapistView(
  therapist: PublicTherapist,
  publicFields: FieldDefinition[],
): Promise<TherapistView> {
  const published = therapist.published;

  // 画像フィールドの media id を全部集める
  const imageDefs = publicFields.filter(
    (d) => d.type === "image" || d.type === "image_gallery",
  );
  const allImageIds: string[] = [];
  for (const def of imageDefs) {
    allImageIds.push(...extractIds(published[def.key]));
  }
  const mediaMap = await getPublicMediaMap(allImageIds);

  // 写真は出現順を保つ（フィールド sort_order → 配列順）
  const photos: PublicMedia[] = [];
  const seen = new Set<string>();
  for (const def of imageDefs) {
    for (const id of extractIds(published[def.key])) {
      const m = mediaMap.get(id);
      if (m && !seen.has(id)) {
        photos.push(m);
        seen.add(id);
      }
    }
  }

  // 汎用フィールド（画像以外）を is_public 順に整形
  const fields: DisplayField[] = [];
  let name = "";
  let catchCopy = "";
  const goodAtTags: string[] = [];
  for (const def of publicFields) {
    if (def.type === "image" || def.type === "image_gallery") continue;
    const value = toDisplayValue(def, published[def.key]);
    if (!value) continue;

    if (def.key === "name" && value.kind === "text") {
      name = value.text;
      continue; // name is used for JSON-LD, not rendered as a display field
    }
    if (def.key === "catch_copy" && value.kind === "text") {
      catchCopy = value.text;
      continue; // キャッチコピーは専用位置で出すのでフィールド列からは除く
    }
    if (value.kind === "tags" && def.isFilterable) {
      goodAtTags.push(...value.tags);
    }
    fields.push({
      key: def.key,
      label: def.label,
      type: def.type,
      groupLabel: def.groupLabel,
      value,
    });
  }

  return {
    slug: therapist.slug,
    photos,
    name,
    catchCopy,
    goodAtTags: Array.from(new Set(goodAtTags)),
    fields,
  };
}

/**
 * 一覧カード用の軽量ビュー（先頭写真・キャッチ・タグのみ）。
 */
export interface TherapistCardView {
  slug: string;
  photo: PublicMedia | null;
  catchCopy: string;
  goodAtTags: string[];
}

/**
 * 複数セラピストのカードビューをまとめて組む（一覧用）。
 * media を一括解決してから各カードへ割り当てる。
 */
export async function buildTherapistCards(
  therapists: PublicTherapist[],
  publicFields: FieldDefinition[],
): Promise<TherapistCardView[]> {
  const imageDefs = publicFields.filter(
    (d) => d.type === "image" || d.type === "image_gallery",
  );
  const filterableTagDefs = publicFields.filter(
    (d) => (d.type === "multi_select" || d.type === "tag") && d.isFilterable,
  );

  // 全セラピストの先頭画像 id を集めて一括解決
  const allIds: string[] = [];
  const firstIdBySlug = new Map<string, string | null>();
  for (const t of therapists) {
    let first: string | null = null;
    for (const def of imageDefs) {
      const ids = extractIds(t.published[def.key]);
      if (ids.length > 0) {
        first = ids[0] ?? null;
        break;
      }
    }
    firstIdBySlug.set(t.slug, first);
    if (first) allIds.push(first);
  }
  const mediaMap = await getPublicMediaMap(allIds);

  return therapists.map((t) => {
    const firstId = firstIdBySlug.get(t.slug) ?? null;
    const photo = firstId ? (mediaMap.get(firstId) ?? null) : null;

    const catchRaw = t.published["catch_copy"];
    const catchCopy = typeof catchRaw === "string" ? catchRaw : "";

    const tags: string[] = [];
    for (const def of filterableTagDefs) {
      const raw = t.published[def.key];
      if (Array.isArray(raw)) {
        tags.push(...raw.filter((v): v is string => typeof v === "string" && v.length > 0));
      }
    }

    return {
      slug: t.slug,
      photo,
      catchCopy,
      goodAtTags: Array.from(new Set(tags)),
    };
  });
}

/**
 * 一覧の絞り込みに使う「得意な施術」タグ候補を field_definitions から生成する。
 * is_filterable な multi_select / tag の options.choices を統合。
 */
export function collectFilterTagChoices(publicFields: FieldDefinition[]): string[] {
  const choices: string[] = [];
  for (const def of publicFields) {
    if ((def.type === "multi_select" || def.type === "tag") && def.isFilterable) {
      for (const c of def.options?.choices ?? []) {
        if (!choices.includes(c)) choices.push(c);
      }
    }
  }
  return choices;
}
