"use client";

import { useState, useTransition } from "react";
import { memberLogin } from "./actions";

/**
 * 会員ページ ログインフォーム（電話番号 + 暗証番号）。
 * 成功時はサーバ側 redirect で /c/<token> へ遷移する（ここでは何も返らない）。
 * 文言はすべて props（content 由来。日本語リテラルなし）。
 */
export interface MemberLoginLabels {
  phoneLabel: string;
  pinLabel: string;
  loginCta: string;
  errorBad: string;
  errorLocked: string;
  errorInvalid: string;
  loading: string;
}

export function MemberLoginForm({ labels }: { labels: MemberLoginLabels }) {
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError("");
    startTransition(async () => {
      const res = await memberLogin({ phone, pin });
      // 成功時は redirect で遷移するためここには来ない。失敗のみ res が返る。
      if (res && !res.ok) {
        setError(
          res.error === "locked"
            ? labels.errorLocked
            : res.error === "invalid"
              ? labels.errorInvalid
              : labels.errorBad,
        );
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4 rounded border border-pub-border bg-pub-surface p-5"
    >
      <div>
        <label className="mb-1 block text-xs text-pub-subtext" htmlFor="member-phone">
          {labels.phoneLabel}
        </label>
        <input
          id="member-phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, ""))}
          inputMode="tel"
          autoComplete="tel"
          className="w-full rounded border border-pub-border bg-pub-bg px-3 py-2 font-mono text-sm text-pub-text"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-pub-subtext" htmlFor="member-pin">
          {labels.pinLabel}
        </label>
        <input
          id="member-pin"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ""))}
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          className="w-full rounded border border-pub-border bg-pub-bg px-3 py-2 font-mono text-sm tracking-widest text-pub-text"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-pub-primary">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending || !/^0[0-9]{9,10}$/.test(phone) || !/^[0-9]{4,6}$/.test(pin)}
        className="w-full rounded bg-pub-primary px-6 py-2.5 text-sm font-medium text-pub-bg transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {pending && labels.loading ? labels.loading : labels.loginCta}
      </button>
    </form>
  );
}
