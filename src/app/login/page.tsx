import type { Metadata } from "next";
import LoginForm from "./LoginForm";
import { sanitizeNext } from "@/lib/auth/next-path";

export const metadata: Metadata = { title: "ログイン" };
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
        <h1 className="text-lg font-semibold text-adm-primary mb-4">
          管理ログイン
        </h1>
        <LoginForm next={sanitizeNext(next)} />
      </div>
    </div>
  );
}
