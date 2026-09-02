import type { Metadata } from "next";
import Link from "next/link";
import LoginForm from "./LoginForm";
import { sanitizeNext } from "@/lib/auth/next-path";

export const metadata: Metadata = { title: "管理ログイン" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
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
        <h1 className="text-lg font-semibold text-adm-primary mb-1">管理ログイン</h1>
        <p className="text-xs text-adm-muted mb-4">オーナー・管理・受付の方はこちら。</p>
        {/* next 未指定は空にして、ログイン後にロール別の既定（管理=/admin）へ倒す */}
        <LoginForm next={sanitizeNext(next, "")} />
        <p className="text-xs text-adm-muted mt-4">
          セラピストの方は{" "}
          <Link href="/cast/login" className="text-adm-primary underline">
            こちらのログイン
          </Link>
        </p>
      </div>
    </div>
  );
}
