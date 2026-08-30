'use client';

import { useState, useTransition } from 'react';
import type { NotificationRow, NotificationTemplate } from '@/lib/notify/actions';
import type { FlashDealConfig } from '@/domain/flashdeal';
import {
  triggerEnqueueReminders,
  triggerWeeklyReport,
  triggerFlashDealBatch,
  listNotifications,
  saveNotificationTemplate,
  saveFlashDealConfigAction,
} from '@/lib/notify/actions';

interface Props {
  initialNotifications: { rows: NotificationRow[]; total: number } | null;
  initialTemplates: NotificationTemplate[] | null;
  initialFlashConfig: FlashDealConfig | null;
  isEditor: boolean;
  loadError?: string;
}

const KIND_LABELS: Record<string, string> = {
  reminder_prev_day: '前日リマインド',
  reminder_2h: '2時間前リマインド',
  waitlist_open: 'キャンセル待ち通知',
  weekly_report: '週次レポート',
  flash_deal: '直前割通知',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '未送信',
  sent: '送信済',
  failed: '失敗',
  skipped: 'スキップ',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'text-adm-caution bg-yellow-50 border-yellow-200',
  sent: 'text-green-700 bg-green-50 border-green-200',
  failed: 'text-adm-danger bg-red-50 border-red-200',
  skipped: 'text-adm-muted bg-adm-bg border-adm-border',
};

type Tab = 'outbox' | 'templates' | 'flash' | 'triggers';

export default function NotificationsClient({
  initialNotifications,
  initialTemplates,
  initialFlashConfig,
  isEditor,
  loadError,
}: Props) {
  const [tab, setTab] = useState<Tab>('triggers');
  const [notifications, setNotifications] = useState(initialNotifications);
  const [templates, setTemplates] = useState(initialTemplates);
  const [flashConfig, setFlashConfig] = useState(initialFlashConfig);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const showToast = (kind: 'ok' | 'err', message: string) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), 4000);
  };

  // ---------- 手動トリガ ----------
  const handleReminders = () => {
    startTransition(async () => {
      const r = await triggerEnqueueReminders();
      if (r.ok) {
        showToast('ok', `リマインド: ${r.data?.enqueued ?? 0}件生成 / ${r.data?.sent ?? 0}件送信`);
        await refreshOutbox();
      } else {
        showToast('err', r.error ?? '失敗');
      }
    });
  };

  const handleWeekly = () => {
    startTransition(async () => {
      const r = await triggerWeeklyReport();
      if (r.ok) {
        showToast('ok', r.data?.notificationId ? `週次レポート生成: id=${r.data.notificationId}` : '既に生成済みです（dedupe）');
        await refreshOutbox();
      } else {
        showToast('err', r.error ?? '失敗');
      }
    });
  };

  const handleFlashBatch = () => {
    startTransition(async () => {
      const r = await triggerFlashDealBatch();
      if (r.ok) {
        showToast('ok', `直前割: 適用${r.data?.applied}件 / スキップ${r.data?.skipped}件 / 失敗${r.data?.failed}件`);
      } else {
        showToast('err', r.error ?? '失敗');
      }
    });
  };

  const refreshOutbox = async () => {
    const r = await listNotifications({ limit: 50 });
    if (r.ok && r.data) setNotifications(r.data);
  };

  // ---------- テンプレ編集 ----------
  const [editingTemplate, setEditingTemplate] = useState<NotificationTemplate | null>(null);
  const [templateDraft, setTemplateDraft] = useState<Partial<NotificationTemplate>>({});

  const startEdit = (t: NotificationTemplate) => {
    setEditingTemplate(t);
    setTemplateDraft({ ...t });
  };

  const cancelEdit = () => {
    setEditingTemplate(null);
    setTemplateDraft({});
  };

  const handleSaveTemplate = () => {
    if (!editingTemplate) return;
    startTransition(async () => {
      const r = await saveNotificationTemplate(
        editingTemplate.kind,
        templateDraft.subject ?? editingTemplate.subject,
        templateDraft.body ?? editingTemplate.body,
        templateDraft.name ?? editingTemplate.name,
      );
      if (r.ok) {
        showToast('ok', 'テンプレートを保存しました');
        setTemplates((prev) =>
          prev
            ? prev.map((t) =>
                t.kind === editingTemplate.kind ? { ...t, ...templateDraft } as NotificationTemplate : t,
              )
            : prev,
        );
        cancelEdit();
      } else {
        showToast('err', r.error ?? '保存失敗');
      }
    });
  };

  // ---------- 直前割設定 ----------
  const [flashDraft, setFlashDraft] = useState<FlashDealConfig | null>(flashConfig);

  const handleSaveFlash = () => {
    if (!flashDraft) return;
    startTransition(async () => {
      const r = await saveFlashDealConfigAction(flashDraft);
      if (r.ok) {
        showToast('ok', '直前割設定を保存しました');
        setFlashConfig(flashDraft);
      } else {
        showToast('err', r.error ?? '保存失敗');
      }
    });
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'triggers', label: '手動トリガ' },
    { id: 'outbox', label: '通知一覧' },
    { id: 'templates', label: 'テンプレート' },
    { id: 'flash', label: '直前割設定' },
  ];

  return (
    <div className="space-y-6">
      {/* グローバルトースト */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded border text-sm shadow-sm ${
            toast.kind === 'ok'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-adm-danger text-red-800'
          }`}
          style={{ borderRadius: '4px' }}
          aria-live="polite"
        >
          {toast.message}
        </div>
      )}

      {loadError && (
        <div className="bg-red-50 border border-adm-danger text-red-800 rounded p-3 text-sm" style={{ borderRadius: '4px' }}>
          データ読み込み失敗: {loadError}
        </div>
      )}

      {/* タブ */}
      <div className="flex gap-1 border-b border-adm-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === t.id
                ? 'border-adm-primary text-adm-primary font-medium'
                : 'border-transparent text-adm-muted hover:text-adm-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ---- 手動トリガ ---- */}
      {tab === 'triggers' && (
        <section className="space-y-4">
          <p className="text-sm text-adm-muted">
            cron 配線（② メール配信）が繋がるまでの暫定手動トリガです。
            各ボタンは重複送信防止済み（dedupe_key）。
          </p>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* リマインド */}
            <div className="bg-adm-surface border border-adm-border rounded p-5 space-y-3" style={{ borderRadius: '4px' }}>
              <h2 className="text-sm font-semibold text-adm-text">本日分リマインドを生成・送信</h2>
              <p className="text-xs text-adm-muted">
                today+24h 以内の confirmed 予約の前日・2h前リマインドを生成します。
                スタブ送信（outbox 記録のみ）。
              </p>
              <button
                onClick={handleReminders}
                disabled={isPending}
                className="w-full px-3 py-2 bg-adm-primary text-white text-sm rounded disabled:opacity-50 hover:opacity-90 transition-opacity"
                style={{ borderRadius: '4px' }}
              >
                {isPending ? '処理中…' : 'リマインド生成・送信'}
              </button>
            </div>

            {/* 週次レポート */}
            <div className="bg-adm-surface border border-adm-border rounded p-5 space-y-3" style={{ borderRadius: '4px' }}>
              <h2 className="text-sm font-semibold text-adm-text">先週の週次レポートを生成</h2>
              <p className="text-xs text-adm-muted">
                直近の完了週（先週月曜〜日曜）の売上・稼働・不成立を集計し、
                オーナー宛に outbox 記録します（同じ週は1通のみ）。
              </p>
              <button
                onClick={handleWeekly}
                disabled={isPending}
                className="w-full px-3 py-2 bg-adm-primary text-white text-sm rounded disabled:opacity-50 hover:opacity-90 transition-opacity"
                style={{ borderRadius: '4px' }}
              >
                {isPending ? '処理中…' : '週次レポート生成'}
              </button>
            </div>

            {/* 直前割バッチ */}
            <div className="bg-adm-surface border border-adm-border rounded p-5 space-y-3" style={{ borderRadius: '4px' }}>
              <h2 className="text-sm font-semibold text-adm-text">本日の直前割を一括適用</h2>
              <p className="text-xs text-adm-muted">
                本日の confirmed 予約（is_flash_deal=false）に直前割を適用します。
                直前割が無効・条件外は自動スキップ。
              </p>
              <button
                onClick={handleFlashBatch}
                disabled={isPending}
                className="w-full px-3 py-2 bg-adm-caution text-white text-sm rounded disabled:opacity-50 hover:opacity-90 transition-opacity"
                style={{ borderRadius: '4px' }}
              >
                {isPending ? '処理中…' : '直前割バッチ実行'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ---- outbox 一覧 ---- */}
      {tab === 'outbox' && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-adm-muted">
              最新50件を表示（全{notifications?.total ?? 0}件）
            </p>
            <button
              onClick={() => startTransition(refreshOutbox)}
              disabled={isPending}
              className="px-3 py-1.5 text-xs border border-adm-border rounded hover:bg-adm-bg disabled:opacity-50 transition-colors text-adm-text"
              style={{ borderRadius: '4px' }}
            >
              {isPending ? '更新中…' : '更新'}
            </button>
          </div>

          {!notifications && (
            <div className="bg-adm-surface border border-adm-border rounded p-8 text-center text-sm text-adm-muted" style={{ borderRadius: '4px' }}>
              読み込み中…
            </div>
          )}

          {notifications && notifications.rows.length === 0 && (
            <div className="bg-adm-surface border border-adm-border rounded p-8 text-center text-sm text-adm-muted" style={{ borderRadius: '4px' }}>
              通知はまだありません
            </div>
          )}

          {notifications && notifications.rows.length > 0 && (
            <div className="bg-adm-surface border border-adm-border rounded overflow-hidden" style={{ borderRadius: '4px' }}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-adm-border bg-adm-bg">
                    <th className="px-3 py-2 text-left text-xs font-medium text-adm-muted">ID</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-adm-muted">種別</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-adm-muted">宛先</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-adm-muted">件名</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-adm-muted">ステータス</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-adm-muted">送信予定</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-adm-muted">送信日時</th>
                  </tr>
                </thead>
                <tbody>
                  {notifications.rows.map((n, i) => (
                    <tr
                      key={n.id}
                      className={`border-b border-adm-border last:border-0 ${i % 2 === 0 ? '' : 'bg-adm-bg/40'}`}
                    >
                      <td className="px-3 py-2 text-xs text-adm-muted font-mono">{n.id}</td>
                      <td className="px-3 py-2 text-xs">
                        {KIND_LABELS[n.kind] ?? n.kind}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-adm-muted max-w-[120px] truncate" title={n.recipient}>
                        {n.recipient}
                      </td>
                      <td className="px-3 py-2 text-xs max-w-[200px] truncate" title={n.subject}>
                        {n.subject}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-2 py-0.5 text-xs rounded border ${STATUS_COLORS[n.status] ?? 'text-adm-muted border-adm-border'}`}
                          style={{ borderRadius: '4px' }}
                        >
                          {STATUS_LABELS[n.status] ?? n.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-adm-muted font-mono">
                        {n.scheduledFor ? new Date(n.scheduledFor).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-adm-muted font-mono">
                        {n.sentAt ? new Date(n.sentAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ---- テンプレート編集 ---- */}
      {tab === 'templates' && (
        <section className="space-y-4">
          {!templates && (
            <div className="bg-adm-surface border border-adm-border rounded p-8 text-center text-sm text-adm-muted">
              読み込み中…
            </div>
          )}
          {templates && templates.length === 0 && (
            <div className="bg-adm-surface border border-adm-border rounded p-8 text-center text-sm text-adm-muted">
              テンプレートが見つかりません
            </div>
          )}

          {templates && templates.map((t) => {
            const isEditing = editingTemplate?.kind === t.kind;
            return (
              <div
                key={t.kind}
                className="bg-adm-surface border border-adm-border rounded p-5 space-y-3"
                style={{ borderRadius: '4px' }}
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-adm-text">
                    {KIND_LABELS[t.kind] ?? t.kind}
                  </h2>
                  {isEditor && !isEditing && (
                    <button
                      onClick={() => startEdit(t)}
                      className="px-3 py-1.5 text-xs border border-adm-border rounded hover:bg-adm-bg transition-colors text-adm-text"
                      style={{ borderRadius: '4px' }}
                    >
                      編集
                    </button>
                  )}
                </div>

                {isEditing ? (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-adm-muted mb-1">テンプレート名</label>
                      <input
                        value={templateDraft.name ?? t.name}
                        onChange={(e) => setTemplateDraft((d) => ({ ...d, name: e.target.value }))}
                        disabled={isPending}
                        className="w-full border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary disabled:opacity-60"
                        style={{ borderRadius: '4px' }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-adm-muted mb-1">件名</label>
                      <input
                        value={templateDraft.subject ?? t.subject}
                        onChange={(e) => setTemplateDraft((d) => ({ ...d, subject: e.target.value }))}
                        disabled={isPending}
                        className="w-full border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary disabled:opacity-60"
                        style={{ borderRadius: '4px' }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-adm-muted mb-1">本文</label>
                      <textarea
                        value={templateDraft.body ?? t.body}
                        onChange={(e) => setTemplateDraft((d) => ({ ...d, body: e.target.value }))}
                        disabled={isPending}
                        rows={6}
                        className="w-full border border-adm-border rounded px-3 py-2 text-sm font-mono bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary disabled:opacity-60 resize-y"
                        style={{ borderRadius: '4px' }}
                      />
                    </div>
                    <div className="flex gap-3">
                      <button
                        onClick={handleSaveTemplate}
                        disabled={isPending}
                        className="px-4 py-1.5 bg-adm-primary text-white text-sm rounded disabled:opacity-50 hover:opacity-90 transition-opacity"
                        style={{ borderRadius: '4px' }}
                      >
                        {isPending ? '保存中…' : '保存'}
                      </button>
                      <button
                        onClick={cancelEdit}
                        disabled={isPending}
                        className="px-4 py-1.5 border border-adm-border text-adm-text text-sm rounded hover:bg-adm-bg disabled:opacity-50 transition-colors"
                        style={{ borderRadius: '4px' }}
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="text-xs text-adm-muted">
                      名前: <span className="text-adm-text">{t.name}</span>
                    </div>
                    <div className="text-xs text-adm-muted">
                      件名: <span className="text-adm-text">{t.subject}</span>
                    </div>
                    <pre className="mt-2 bg-adm-bg border border-adm-border rounded p-3 text-xs font-mono text-adm-text whitespace-pre-wrap leading-relaxed" style={{ borderRadius: '4px' }}>
                      {t.body}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* ---- 直前割設定 ---- */}
      {tab === 'flash' && (
        <section className="space-y-4">
          {!flashDraft && (
            <div className="bg-adm-surface border border-adm-border rounded p-8 text-center text-sm text-adm-muted">
              読み込み中…
            </div>
          )}

          {flashDraft && (
            <div className="bg-adm-surface border border-adm-border rounded p-6 space-y-5" style={{ borderRadius: '4px' }}>
              <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
                直前割 CMS 設定
              </h2>
              <p className="text-xs text-adm-muted">
                当日の予約を指定時刻以降・対象時間帯の場合に割引するルールです。
                変更は次回バッチ実行から反映されます。
              </p>

              {/* enabled */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-adm-text w-40">有効化</label>
                <input
                  type="checkbox"
                  checked={flashDraft.enabled}
                  onChange={(e) => setFlashDraft((d) => d ? { ...d, enabled: e.target.checked } : d)}
                  disabled={!isEditor || isPending}
                  className="w-4 h-4 accent-adm-primary"
                />
                <span className="text-xs text-adm-muted">
                  {flashDraft.enabled ? '有効' : '無効（既定: 無効）'}
                </span>
              </div>

              {/* ratePercent */}
              <FlashNumberField
                label="割引率（%）"
                value={flashDraft.ratePercent}
                min={1} max={100}
                disabled={!isEditor || isPending}
                onChange={(v) => setFlashDraft((d) => d ? { ...d, ratePercent: v } : d)}
              />

              {/* triggerHour */}
              <FlashNumberField
                label="発火時刻（JST 時）"
                value={flashDraft.triggerHour}
                min={0} max={23}
                disabled={!isEditor || isPending}
                onChange={(v) => setFlashDraft((d) => d ? { ...d, triggerHour: v } : d)}
                hint="この時刻以降に対象予約が適用対象になります"
              />

              {/* windowFromHour */}
              <FlashNumberField
                label="対象開始時 (from)"
                value={flashDraft.windowFromHour}
                min={0} max={23}
                disabled={!isEditor || isPending}
                onChange={(v) => setFlashDraft((d) => d ? { ...d, windowFromHour: v } : d)}
                hint="施術開始時刻がこの時間以降の予約が対象"
              />

              {/* windowToHour */}
              <FlashNumberField
                label="対象終了時 (to)"
                value={flashDraft.windowToHour}
                min={1} max={24}
                disabled={!isEditor || isPending}
                onChange={(v) => setFlashDraft((d) => d ? { ...d, windowToHour: v } : d)}
                hint="施術開始時刻がこの時間未満の予約が対象"
              />

              {/* dailyLimit */}
              <FlashNumberField
                label="1日上限（件）"
                value={flashDraft.dailyLimit}
                min={1} max={100}
                disabled={!isEditor || isPending}
                onChange={(v) => setFlashDraft((d) => d ? { ...d, dailyLimit: v } : d)}
              />

              {isEditor && (
                <button
                  onClick={handleSaveFlash}
                  disabled={isPending}
                  className="px-4 py-2 bg-adm-primary text-white text-sm rounded disabled:opacity-50 hover:opacity-90 transition-opacity"
                  style={{ borderRadius: '4px' }}
                >
                  {isPending ? '保存中…' : '設定を保存'}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function FlashNumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <label className="text-sm text-adm-text w-40 pt-1 shrink-0">{label}</label>
      <div className="space-y-1">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v)) onChange(v);
          }}
          disabled={disabled}
          className="w-24 border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary disabled:opacity-60"
          style={{ borderRadius: '4px' }}
        />
        {hint && <p className="text-xs text-adm-muted">{hint}</p>}
      </div>
    </div>
  );
}
