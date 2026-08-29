"use client";

/**
 * 公開側の匿名セッション id（ファネル計測 / 付録B-2）。
 * 個人情報を含まないランダム UUID を sessionStorage に保持し、
 * 訪問〜確定までの一連のイベントを同じ id で紐づける。
 */

const STORAGE_KEY = "funnel_session_id";

export function getFunnelSessionId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.sessionStorage.getItem(STORAGE_KEY);
    if (existing && existing.length >= 8) return existing;
    const generated = crypto.randomUUID();
    window.sessionStorage.setItem(STORAGE_KEY, generated);
    return generated;
  } catch {
    // sessionStorage 不可（プライベートモード等）: 計測なしで導線は生かす
    return crypto.randomUUID();
  }
}
