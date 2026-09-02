import type { Metadata } from "next";
import Link from "next/link";
import LoginForm from "@/app/login/LoginForm";
import { sanitizeNext } from "@/lib/auth/next-path";

export const metadata: Metadata = { title: "セラピスト ログイン" };
export const dynamic = "force-dynamic";

/**
 * セラピスト（キャスト）専用ログイン。管理ログイン（/login）とは別ページ。
 * 認証処理は共通の signIn（LoginForm）。ログイン後はロールで着地するため
 * therapist は自動で /mypage へ（next 明示時はそれを尊重）。
 */
export default async function CastLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <div className="min-h-screen bg-adm-bg text-adm-text flex items-center justify-center px-4">
      <div
        className="w-full max-w-sm bg-adm-surface border border-adm-border p-6"
        style={{ borderRadius: "4px" }}
      >
        <h1 className="text-lg font-semibold text-adm-primary mb-1">セラピスト ログイン</h1>
        <p className="text-xs text-adm-muted mb-4">マイページ（予定・出退勤・稼ぎ）はこちら。</p>
        {/* next 未指定は空にして、ログイン後にロール別の既定（セラピスト=/mypage）へ倒す */}
        <LoginForm next={sanitizeNext(next, "")} />
        <p className="text-xs text-adm-muted mt-4">
          管理の方は{" "}
          <Link href="/login" className="text-adm-primary underline">
            管理ログイン
          </Link>
        </p>
      </div>
    </div>
  );
}
