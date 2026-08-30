import "server-only";

/**
 * Anthropic クライアントの遅延生成（フェーズ21 / spec 19章）。
 *
 * 方針（[[feedback-no-over-configuration]]）:
 * - ANTHROPIC_API_KEY はローカル/CI には無い（Vercel のみ）
 * - import 時に throw しない。`next build` を壊さない
 * - クライアント生成と API 呼び出しは実行時にだけ行う
 * - キーが無ければ null を返し、呼び出し元が `{ ok: false, error: 'AIが未設定です' }` を返す
 *
 * テスト: vi.mock('@anthropic-ai/sdk') でモック差し替え可能にするため、
 * import は静的に行いクライアントインスタンス化のみを遅延する。
 */

import Anthropic from "@anthropic-ai/sdk";

export type AnthropicClient = Anthropic;

let _client: AnthropicClient | null | undefined = undefined; // undefined = 未初期化

/** 遅延クライアント取得。キー未設定なら null */
export function getAnthropicClient(): AnthropicClient | null {
  if (_client !== undefined) return _client;
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key || key.length === 0) {
    _client = null;
    return null;
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

/** テスト用: キャッシュをリセットする */
export function _resetClientCache(): void {
  _client = undefined;
}
