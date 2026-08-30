import "server-only";

/**
 * AI 生成関数（フェーズ21 / spec 19章 L1248-L1256）。
 *
 * - 出力は必ず「提案(draft/diff)」であって適用ではない
 * - AI 出力にも禁止語チェックをかける（二重防御 / spec L1256）
 * - キー未設定なら { ok: false, error: 'AIが未設定です（ANTHROPIC_API_KEY）' } を返す
 * - エラーは型付き例外を catch し、生の内部情報を露出しない
 */

import { getAnthropicClient } from "./client";
import { checkBannedWords } from "@/domain/cms/banned-words";

/** 生成の種別 */
export type GenerateKind =
  | "profile"        // セラピストプロフィール文
  | "catch"          // キャッチコピー
  | "news"           // お知らせ文
  | "faq_answer"     // FAQ の回答
  | "seo_title"      // SEO タイトル
  | "seo_description" // SEO ディスクリプション
  | "rewrite"        // リライト・トーン調整
  | "terminology";   // 用語統一案

/** generateDraft の入力 */
export interface GenerateDraftInput {
  kind: GenerateKind;
  /** 編集対象の既存テキスト（リライト時など） */
  context?: string;
  /** 追加指示（任意） */
  instruction?: string;
  /** 禁止語リスト（AI 出力にも適用） */
  bannedWords?: string[];
}

/** generateDraft の出力 */
export interface GenerateDraftResult {
  ok: true;
  draft: string;
  /** AI 出力に含まれていた禁止語（警告用） */
  detectedBannedWords?: string[];
}

export interface GenerateDraftError {
  ok: false;
  error: string;
}

/** suggestBannedWordRewrite の入力 */
export interface BannedWordRewriteInput {
  text: string;
  bannedWords: string[];
}

/** suggestBannedWordRewrite の出力 */
export interface BannedWordRewriteResult {
  ok: true;
  /** 検出された禁止語 */
  detected: string[];
  /** 禁止語を含まない言い換え案 */
  suggestion: string;
}

export interface BannedWordRewriteError {
  ok: false;
  error: string;
}

/** suggestTerminology の入力 */
export interface TerminologySuggestInput {
  text: string;
  /** terminology テーブルの { key, value } 配列 */
  terminology: Array<{ key: string; value: string }>;
}

/** suggestTerminology の出力 */
export interface TerminologySuggestResult {
  ok: true;
  /** 修正後のテキスト */
  suggestion: string;
  /** 変更箇所の説明 */
  changes: string[];
}

export interface TerminologySuggestError {
  ok: false;
  error: string;
}

// ---------------------------------------------------------------------------
// AI レスポンスから text ブロックを取り出す
// ---------------------------------------------------------------------------

function extractText(content: Array<{ type: string; text?: string }>): string {
  for (const block of content) {
    if (block.type === "text" && block.text) return block.text.trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// エラーを安全なメッセージに変換
// ---------------------------------------------------------------------------

function safeError(e: unknown): string {
  if (e instanceof Error) {
    const status = (e as { status?: number }).status;
    if (status === 429) return "AIのレート制限に達しました。しばらく待ってから再試行してください";
    if (status === 401) return "AI認証に失敗しました。ANTHROPIC_API_KEYを確認してください";
    if (e.name === "APIConnectionError") return "AI接続に失敗しました。ネットワーク設定を確認してください";
    if (e.name === "APIError") return `AIエラー（${status ?? "不明"}）: リクエストを確認してください`;
    return e.message;
  }
  return "AIで不明なエラーが発生しました";
}

// ---------------------------------------------------------------------------
// モデル設定（spec 指定: claude-opus-4-8 + adaptive thinking）
// ---------------------------------------------------------------------------

const MODEL = "claude-opus-4-8" as const;
const MAX_TOKENS = 16000;

// ---------------------------------------------------------------------------
// 1. generateDraft: 下書き生成・リライト・トーン調整
// ---------------------------------------------------------------------------

/**
 * プロフィール文/キャッチ/お知らせ/FAQ/SEO の下書き生成またはリライト（spec 19-1 L1248）。
 * 出力は提案のみ。適用は Server Action の approveAiAction で行う。
 */
export async function generateDraft(
  input: GenerateDraftInput,
): Promise<GenerateDraftResult | GenerateDraftError> {
  const client = getAnthropicClient();
  if (!client) return { ok: false, error: "AIが未設定です（ANTHROPIC_API_KEY）" };

  const systemPrompts: Record<GenerateKind, string> = {
    profile: "あなたはリラクゼーションサロンのライターです。セラピストの魅力を伝える自然で温かみのあるプロフィール文を書いてください。出力はプロフィール本文のみ。",
    catch: "あなたはリラクゼーションサロンのコピーライターです。セラピストの魅力を一文で伝えるキャッチコピーを書いてください。出力はキャッチコピーのみ（50文字以内）。",
    news: "あなたはリラクゼーションサロンの広報担当です。お知らせ文を丁寧で読みやすく書いてください。出力は本文のみ。",
    faq_answer: "あなたはリラクゼーションサロンのFAQ担当です。質問に対して丁寧で分かりやすい回答を書いてください。出力は回答のみ。",
    seo_title: "あなたはSEOの専門家です。リラクゼーションサロンのSEOタイトルを30〜60文字で書いてください。出力はタイトルのみ。",
    seo_description: "あなたはSEOの専門家です。リラクゼーションサロンのメタディスクリプションを80〜120文字で書いてください。出力はディスクリプションのみ。",
    rewrite: "あなたはプロの編集者です。与えられたテキストをより自然で読みやすくリライトしてください。トーンを保ちながら改善してください。出力は改善後のテキストのみ。",
    terminology: "あなたはリラクゼーションサロンの用語整理担当です。用語辞書に従って表記を統一してください。出力は修正後のテキストのみ。",
  };

  const system = systemPrompts[input.kind];
  let userContent = "";
  if (input.context) {
    userContent += `【既存テキスト】\n${input.context}\n\n`;
  }
  if (input.instruction) {
    userContent += `【指示】\n${input.instruction}`;
  }
  if (!userContent) {
    userContent = "上記の指示に従って生成してください。";
  }

  try {
    const response = (await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: userContent }],
    })) as { content: Array<{ type: string; text?: string }> };

    const draft = extractText(response.content);
    if (!draft) return { ok: false, error: "AIから空のレスポンスが返りました" };

    // AI 出力にも禁止語チェック（二重防御）
    const detectedBannedWords =
      input.bannedWords && input.bannedWords.length > 0
        ? checkBannedWords(draft, input.bannedWords)
        : [];

    return {
      ok: true,
      draft,
      ...(detectedBannedWords.length > 0 ? { detectedBannedWords } : {}),
    };
  } catch (e) {
    return { ok: false, error: safeError(e) };
  }
}

// ---------------------------------------------------------------------------
// 2. suggestBannedWordRewrite: 禁止語言い換え提案
// ---------------------------------------------------------------------------

/**
 * 禁止語を検出し、法に触れない言い換え案を提案する（spec L1250）。
 * 検出は既存 checkBannedWords を使う。AI は言い換えのみ担当。
 */
export async function suggestBannedWordRewrite(
  input: BannedWordRewriteInput,
): Promise<BannedWordRewriteResult | BannedWordRewriteError> {
  const detected = checkBannedWords(input.text, input.bannedWords);

  if (detected.length === 0) {
    // 禁止語なし = そのまま返す（AI 不要）
    return { ok: true, detected: [], suggestion: input.text };
  }

  const client = getAnthropicClient();
  if (!client) {
    return { ok: false, error: "AIが未設定です（ANTHROPIC_API_KEY）。禁止語が検出されました: " + detected.join("、") };
  }

  const system =
    "あなたはリラクゼーション業界の法務アドバイザーです。" +
    "医療・性的表現・薬機法・景品表示法に抵触する可能性のある表現を検出し、" +
    "法に触れない自然な表現に言い換えてください。" +
    "出力は言い換え後のテキストのみ。";

  const userContent =
    `【禁止語】: ${detected.join("、")}\n\n` +
    `【テキスト】:\n${input.text}\n\n` +
    "上記テキストから禁止語を取り除き、自然な表現に言い換えてください。";

  try {
    const response = (await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: userContent }],
    })) as { content: Array<{ type: string; text?: string }> };

    const suggestion = extractText(response.content);
    if (!suggestion) return { ok: false, error: "AIから空のレスポンスが返りました" };

    return { ok: true, detected, suggestion };
  } catch (e) {
    return { ok: false, error: safeError(e) };
  }
}

// ---------------------------------------------------------------------------
// 3. suggestTerminology: 用語辞書に従う表記ゆれ統一案
// ---------------------------------------------------------------------------

/**
 * 用語辞書に従って表記ゆれを統一する提案を生成する（spec L1251）。
 */
export async function suggestTerminology(
  input: TerminologySuggestInput,
): Promise<TerminologySuggestResult | TerminologySuggestError> {
  if (input.terminology.length === 0) {
    return { ok: true, suggestion: input.text, changes: [] };
  }

  const client = getAnthropicClient();
  if (!client) return { ok: false, error: "AIが未設定です（ANTHROPIC_API_KEY）" };

  const terminologyList = input.terminology
    .map((t) => `- ${t.key}: ${t.value}`)
    .join("\n");

  const system =
    "あなたはテキスト編集の専門家です。" +
    "与えられた用語辞書に従って、テキスト内の表記ゆれを統一してください。" +
    "辞書にない単語は変更しないでください。" +
    "出力形式: JSON { \"suggestion\": \"修正後テキスト\", \"changes\": [\"変更内容1\", ...] }";

  const userContent =
    `【用語辞書】:\n${terminologyList}\n\n` +
    `【テキスト】:\n${input.text}\n\n` +
    "上記用語辞書に従って表記ゆれを統一し、JSON形式で出力してください。";

  try {
    const response = (await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: userContent }],
    })) as { content: Array<{ type: string; text?: string }> };

    const raw = extractText(response.content);
    if (!raw) return { ok: false, error: "AIから空のレスポンスが返りました" };

    // JSON パース（コードブロック除去）
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let parsed: { suggestion: string; changes: string[] };
    try {
      parsed = JSON.parse(jsonStr) as { suggestion: string; changes: string[] };
    } catch {
      // JSON でなければ全体をそのまま suggestion として扱う
      return { ok: true, suggestion: raw, changes: [] };
    }

    return {
      ok: true,
      suggestion: parsed.suggestion ?? raw,
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
    };
  } catch (e) {
    return { ok: false, error: safeError(e) };
  }
}
