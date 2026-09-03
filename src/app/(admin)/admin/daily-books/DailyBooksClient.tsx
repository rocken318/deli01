"use client";

/**
 * 日次会計（G）の表示＋操作。
 * - 期間トグル（日/週/月）・前後ナビ・日付入力 → URL クエリ更新（サーバ再取得）
 * - 店舗合計カード（売上/バック/経費/粗利）・個人別テーブル・支払方法内訳
 * - 経費の手入力（addExpense）＋一覧。追加後は router.refresh で再集計。
 * デザインは spec 12-2（管理側）トークン。金額は整数円。
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addExpense, deleteExpense } from "@/lib/accounting/actions";
import type { DailyBooksView } from "@/lib/accounting/actions";
import type { ExpenseItem, ExpenseCategory } from "@/lib/accounting/queries";
import type { BooksPeriod } from "@/domain/accounting";
import MonthCalendar from "./MonthCalendar";

const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  oil: "オイル",
  supplies: "備品",
  parking: "駐車場代",
  ads: "広告費",
  other: "その他",
};
const PAYMENT_LABEL: Record<string, string> = {
  cash: "現金",
  card: "カード",
  emoney: "電子マネー",
  ticket: "回数券",
  point: "ポイント",
};
const PERIODS: { key: BooksPeriod; label: string }[] = [
  { key: "day", label: "日" },
  { key: "week", label: "週" },
  { key: "month", label: "月" },
];

const yen = (n: number) => `¥${n.toLocaleString()}`;

/** dateISO を period 単位で n 個ずらす（日=±1日 / 週=±7日 / 月=±1ヶ月）。 */
function shiftDate(dateISO: string, period: BooksPeriod, n: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  if (period === "month") {
    const base = new Date(Date.UTC(y!, m! - 1 + n, 1));
    return base.toISOString().slice(0, 10);
  }
  const days = period === "week" ? 7 * n : n;
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export default function DailyBooksClient({
  dateISO,
  period,
  todayISO,
  books,
  expenses,
}: {
  dateISO: string;
  period: BooksPeriod;
  todayISO: string;
  books: DailyBooksView | null;
  expenses: ExpenseItem[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // 経費入力
  const [expCategory, setExpCategory] = useState<ExpenseCategory>("oil");
  const [expAmount, setExpAmount] = useState("");
  const [expDate, setExpDate] = useState(dateISO);
  const [expNote, setExpNote] = useState("");
  const [expMsg, setExpMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showCal, setShowCal] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const go = (nextDate: string, nextPeriod: BooksPeriod) => {
    startTransition(() => {
      router.push(`/admin/daily-books?date=${nextDate}&period=${nextPeriod}`);
    });
  };

  const removeExpense = async (id: string) => {
    if (!window.confirm("この経費を削除しますか？")) return;
    setDeletingId(id);
    const res = await deleteExpense(id);
    setDeletingId(null);
    if (res.ok) startTransition(() => router.refresh());
    else setExpMsg({ ok: false, text: res.error ?? "削除に失敗しました" });
  };

  const csvHref = (type: "summary" | "expenses") =>
    `/admin/daily-books/export?date=${dateISO}&period=${period}&type=${type}`;

  const submitExpense = async () => {
    const amount = Number(expAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      setExpMsg({ ok: false, text: "金額は正の整数で入力してください" });
      return;
    }
    setSaving(true);
    setExpMsg(null);
    const res = await addExpense({
      category: expCategory,
      amount,
      spentOn: expDate,
      note: expNote.trim() || null,
    });
    setSaving(false);
    if (res.ok) {
      setExpAmount("");
      setExpNote("");
      setExpMsg({ ok: true, text: "経費を登録しました" });
      startTransition(() => router.refresh());
    } else {
      setExpMsg({ ok: false, text: res.error ?? "経費の登録に失敗しました" });
    }
  };

  const card = "bg-adm-surface border border-adm-line rounded p-3";
  const chip = (active: boolean) =>
    `px-3 py-1 text-sm font-semibold rounded ${active ? "bg-adm-primary text-white" : "bg-white border border-adm-line text-adm-muted"}`;

  return (
    <div className="space-y-4">
      {/* ナビ */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button key={p.key} type="button" className={chip(period === p.key)} onClick={() => go(dateISO, p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        <button type="button" className="px-2 py-1 text-sm border border-adm-line rounded bg-white text-adm-text" onClick={() => go(shiftDate(dateISO, period, -1), period)}>
          ← 前
        </button>
        <input
          type="date"
          value={dateISO}
          onChange={(e) => e.target.value && go(e.target.value, period)}
          className="border border-adm-line rounded px-2 py-1 text-sm text-adm-text bg-white [color-scheme:light]"
        />
        <button type="button" className="px-2 py-1 text-sm border border-adm-line rounded bg-white text-adm-text" onClick={() => go(shiftDate(dateISO, period, 1), period)}>
          次 →
        </button>
        <button type="button" className="px-2 py-1 text-sm border border-adm-line rounded bg-white text-adm-muted" onClick={() => go(todayISO, period)}>
          今日
        </button>
        <button type="button" className={chip(showCal)} onClick={() => setShowCal((v) => !v)}>
          📅 カレンダー
        </button>
        {books && <span className="text-sm text-adm-muted ml-1">{books.label}</span>}
        {isPending && <span className="text-xs text-adm-muted">更新中…</span>}
      </div>

      {showCal && (
        <MonthCalendar
          dateISO={dateISO}
          todayISO={todayISO}
          onPick={(d) => {
            setShowCal(false);
            go(d, "day");
          }}
        />
      )}

      {!books ? (
        <p className="text-adm-muted">データを取得できませんでした。</p>
      ) : (
        <>
          {/* 店舗合計 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className={card}>
              <p className="text-xs font-semibold text-adm-muted">売上</p>
              <p className="text-2xl font-bold text-adm-text tabular-nums">{yen(books.storeTotal.revenue)}</p>
              <p className="text-xs text-adm-muted">{books.storeTotal.reservationCount}件</p>
            </div>
            <div className={card}>
              <p className="text-xs font-semibold text-adm-muted">バック（報酬）</p>
              <p className="text-2xl font-bold text-adm-text tabular-nums">{yen(books.storeTotal.payout)}</p>
            </div>
            <div className={card}>
              <p className="text-xs font-semibold text-adm-muted">経費</p>
              <p className="text-2xl font-bold text-adm-text tabular-nums">{yen(books.storeTotal.expenses)}</p>
            </div>
            <div className={`${card} bg-adm-primary/5 border-adm-primary/40`}>
              <p className="text-xs font-semibold text-adm-muted">粗利（売上−バック−経費）</p>
              <p className={`text-2xl font-bold tabular-nums ${books.storeTotal.grossProfit < 0 ? "text-adm-danger" : "text-adm-primary"}`}>
                {yen(books.storeTotal.grossProfit)}
              </p>
            </div>
          </div>

          {/* 交通費お預り（売上・バック・粗利には含めない通過項目） */}
          <p className="text-xs text-adm-muted">
            交通費お預り（ドライバー代の原資・売上外）:{" "}
            <span className="text-adm-text tabular-nums font-semibold">{yen(books.transportPassthrough)}</span>
            <span className="ml-1">＝お客様から集金し店がドライバーへ支払う経費で相殺（粗利に影響なし）</span>
          </p>

          {/* 個人別 */}
          <div className={card}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-adm-text">個人別（売上・バック・店取分）</p>
              <a href={csvHref("summary")} className="text-xs text-adm-primary underline">集計CSV</a>
            </div>
            {books.byTherapist.length === 0 ? (
              <p className="text-sm text-adm-muted">この期間の売上・バックはありません。</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-adm-muted border-b border-adm-line">
                    <th className="text-left font-medium py-1">セラピスト</th>
                    <th className="text-right font-medium py-1">件数</th>
                    <th className="text-right font-medium py-1">売上</th>
                    <th className="text-right font-medium py-1">バック</th>
                    <th className="text-right font-medium py-1">店取分</th>
                  </tr>
                </thead>
                <tbody>
                  {books.byTherapist.map((t) => (
                    <tr key={t.therapistId} className="border-b border-adm-line/60">
                      <td className="py-1 text-adm-text">{t.therapistName}</td>
                      <td className="py-1 text-right tabular-nums text-adm-muted">{t.reservationCount}</td>
                      <td className="py-1 text-right tabular-nums text-adm-text">{yen(t.revenue)}</td>
                      <td className="py-1 text-right tabular-nums text-adm-text">{yen(t.payout)}</td>
                      <td className="py-1 text-right tabular-nums text-adm-text">{yen(t.storeShare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 支払方法内訳 */}
          <div className={card}>
            <p className="text-sm font-semibold text-adm-text mb-2">支払方法内訳</p>
            <div className="flex flex-wrap gap-4 text-sm">
              {Object.entries(books.paymentsByMethod).map(([m, v]) => (
                <span key={m} className="text-adm-muted">
                  {PAYMENT_LABEL[m] ?? m}: <span className="text-adm-text tabular-nums font-semibold">{yen(v)}</span>
                </span>
              ))}
            </div>
          </div>

          {/* 経費入力 */}
          <div className={card}>
            <p className="text-sm font-semibold text-adm-text mb-2">経費を入力</p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-adm-muted">
                カテゴリ<br />
                <select
                  value={expCategory}
                  onChange={(e) => setExpCategory(e.target.value as ExpenseCategory)}
                  className="border border-adm-line rounded px-2 py-1 text-sm text-adm-text bg-white [color-scheme:light]"
                >
                  {(Object.keys(EXPENSE_CATEGORY_LABEL) as ExpenseCategory[]).map((c) => (
                    <option key={c} value={c}>{EXPENSE_CATEGORY_LABEL[c]}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-adm-muted">
                金額（円）<br />
                <input
                  inputMode="numeric"
                  value={expAmount}
                  onChange={(e) => setExpAmount(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="3000"
                  className="border border-adm-line rounded px-2 py-1 text-sm text-adm-text bg-white w-24 [color-scheme:light]"
                />
              </label>
              <label className="text-xs text-adm-muted">
                日付<br />
                <input
                  type="date"
                  value={expDate}
                  onChange={(e) => setExpDate(e.target.value)}
                  className="border border-adm-line rounded px-2 py-1 text-sm text-adm-text bg-white [color-scheme:light]"
                />
              </label>
              <label className="text-xs text-adm-muted flex-1 min-w-[160px]">
                メモ<br />
                <input
                  value={expNote}
                  onChange={(e) => setExpNote(e.target.value)}
                  placeholder="内容（任意）"
                  className="border border-adm-line rounded px-2 py-1 text-sm text-adm-text bg-white w-full [color-scheme:light]"
                />
              </label>
              <button
                type="button"
                onClick={submitExpense}
                disabled={saving}
                className="px-4 py-1.5 text-sm font-semibold rounded bg-adm-primary text-white disabled:opacity-50"
              >
                {saving ? "登録中…" : "追加"}
              </button>
            </div>
            {expMsg && (
              <p className={`text-sm mt-2 ${expMsg.ok ? "text-adm-primary" : "text-adm-danger"}`}>{expMsg.text}</p>
            )}
          </div>

          {/* 経費一覧 */}
          <div className={card}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-adm-text">経費一覧（{books.label}）</p>
              <a href={csvHref("expenses")} className="text-xs text-adm-primary underline">経費CSV</a>
            </div>
            {expenses.length === 0 ? (
              <p className="text-sm text-adm-muted">この期間の経費はありません。</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-adm-muted border-b border-adm-line">
                    <th className="text-left font-medium py-1">日付</th>
                    <th className="text-left font-medium py-1">カテゴリ</th>
                    <th className="text-right font-medium py-1">金額</th>
                    <th className="text-left font-medium py-1 pl-3">メモ</th>
                    <th className="text-right font-medium py-1">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((e) => (
                    <tr key={e.id} className="border-b border-adm-line/60">
                      <td className="py-1 text-adm-text tabular-nums">{e.spentOn}</td>
                      <td className="py-1 text-adm-text">{EXPENSE_CATEGORY_LABEL[e.category] ?? e.category}</td>
                      <td className="py-1 text-right tabular-nums text-adm-text">{yen(e.amount)}</td>
                      <td className="py-1 pl-3 text-adm-muted">{e.note ?? ""}</td>
                      <td className="py-1 text-right">
                        <button
                          type="button"
                          onClick={() => removeExpense(e.id)}
                          disabled={deletingId === e.id}
                          className="text-xs text-adm-danger underline disabled:opacity-50"
                        >
                          {deletingId === e.id ? "削除中…" : "削除"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
