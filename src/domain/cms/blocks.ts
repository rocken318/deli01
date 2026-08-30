/**
 * CMS ブロック型（spec 3-6）。
 * ブロックはホワイトリスト限定（10種）。幅・色・フォントは選ばせない。
 */

import { z } from "zod";

export const BLOCK_TYPES = [
  "hero",
  "text",
  "image",
  "text_image",
  "therapist_picks",
  "course_list",
  "steps",
  "faq",
  "notice",
  "cta",
  "play",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

const blockBase = z.object({
  id: z.string().min(1),
  visible: z.boolean().default(true),
});

export const heroBlockSchema = blockBase.extend({
  type: z.literal("hero"),
  heading: z.string().default(""),
  subheading: z.string().default(""),
  imageId: z.string().nullable().default(null),
  ctaLabel: z.string().default(""),
  ctaHref: z.string().default(""),
});

export const textBlockSchema = blockBase.extend({
  type: z.literal("text"),
  body: z.string().default(""),
});

export const imageBlockSchema = blockBase.extend({
  type: z.literal("image"),
  imageId: z.string().nullable().default(null),
  alt: z.string().default(""),
  caption: z.string().default(""),
});

export const textImageBlockSchema = blockBase.extend({
  type: z.literal("text_image"),
  body: z.string().default(""),
  imageId: z.string().nullable().default(null),
  imagePosition: z.enum(["left", "right"]).default("right"),
  alt: z.string().default(""),
});

export const therapistPicksBlockSchema = blockBase.extend({
  type: z.literal("therapist_picks"),
  heading: z.string().default(""),
  slugs: z.array(z.string()).default([]),
});

export const courseListBlockSchema = blockBase.extend({
  type: z.literal("course_list"),
  heading: z.string().default(""),
});

export const stepsBlockSchema = blockBase.extend({
  type: z.literal("steps"),
  heading: z.string().default(""),
  items: z.array(z.object({ label: z.string(), body: z.string() })).default([]),
});

export const faqBlockSchema = blockBase.extend({
  type: z.literal("faq"),
  heading: z.string().default(""),
  items: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
});

export const noticeBlockSchema = blockBase.extend({
  type: z.literal("notice"),
  body: z.string().default(""),
});

export const ctaBlockSchema = blockBase.extend({
  type: z.literal("cta"),
  label: z.string().default(""),
  href: z.string().default(""),
  subtext: z.string().default(""),
});

/**
 * プレイ内容ブロック（自動採番の繰り返し項目）。
 * heading = セクション見出し（例「プレイ内容」）。items = 各プレイの内容本文。
 * 公開側は「{play_item_label}{n}」の見出し（label は用語辞書由来）＋ body を描画する。
 */
export const playBlockSchema = blockBase.extend({
  type: z.literal("play"),
  heading: z.string().default(""),
  items: z.array(z.object({ body: z.string() })).default([]),
});

export const blockSchema = z.discriminatedUnion("type", [
  heroBlockSchema,
  textBlockSchema,
  imageBlockSchema,
  textImageBlockSchema,
  therapistPicksBlockSchema,
  courseListBlockSchema,
  stepsBlockSchema,
  faqBlockSchema,
  noticeBlockSchema,
  ctaBlockSchema,
  playBlockSchema,
]);

export const blocksArraySchema = z.array(blockSchema);

export type HeroBlock = z.infer<typeof heroBlockSchema>;
export type TextBlock = z.infer<typeof textBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type TextImageBlock = z.infer<typeof textImageBlockSchema>;
export type TherapistPicksBlock = z.infer<typeof therapistPicksBlockSchema>;
export type CourseListBlock = z.infer<typeof courseListBlockSchema>;
export type StepsBlock = z.infer<typeof stepsBlockSchema>;
export type FaqBlock = z.infer<typeof faqBlockSchema>;
export type NoticeBlock = z.infer<typeof noticeBlockSchema>;
export type CtaBlock = z.infer<typeof ctaBlockSchema>;
export type PlayBlock = z.infer<typeof playBlockSchema>;
export type Block = z.infer<typeof blockSchema>;
