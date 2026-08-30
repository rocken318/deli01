"use client";

import { useActionState } from "react";
import { signIn, type LoginState } from "./actions";

const initial: LoginState = { error: null };

export default function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(signIn, initial);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-adm-text">メールアドレス</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="username"
          className="border border-adm-border bg-adm-surface text-adm-text px-3 py-2"
          style={{ borderRadius: "4px" }}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-adm-text">パスワード</span>
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          className="border border-adm-border bg-adm-surface text-adm-text px-3 py-2"
          style={{ borderRadius: "4px" }}
        />
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-adm-danger">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="bg-adm-primary text-white px-4 py-2 disabled:opacity-60"
        style={{ borderRadius: "4px" }}
      >
        {pending ? "確認中…" : "ログイン"}
      </button>
    </form>
  );
}
