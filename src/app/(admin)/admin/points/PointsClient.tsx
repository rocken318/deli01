'use client';

/**
 * ポイント管理クライアントコンポーネント（フェーズ16 / spec 12-2）。
 * 4セクション: 残高照会・手動付与・失効一覧・指名NG管理。
 * any 禁止・金額/ポイントは整数。空状態・ローディング・エラーの3状態。
 */

import { useState, useTransition } from 'react';
import { formatInTimeZone } from 'date-fns-tz';
import { earnPoints, expirePoints, listPointLedger } from '@/lib/points/actions';
import type { ExpiringLotItem } from '@/lib/points/queries';
import type { PointLedgerEntry } from '@/lib/points/actions';
import { addNgPair, removeNgPair } from '@/lib/nomination/actions';
import { getCustomerPortalLink, setCustomerPortalPin } from '@/lib/customer-portal/admin-actions';
import type { NgPairRow } from '@/lib/nomination/actions';

const TZ = 'Asia/Tokyo';

const TYPE_LABEL: Record<string, string> = {
  earn: '付与',
  use: '利用',
  expire: '失効',
  adjust: '調整',
  reverse: '逆仕訳',
};

interface TherapistOption {
  id: string;
  name: string;
}

interface CustomerOption {
  id: string;
  name: string;
  phone: string;
}

interface Props {
  initialExpiringLots: ExpiringLotItem[];
  expiringError: string | null;
  initialNgPairs: NgPairRow[];
  ngError: string | null;
  therapists: TherapistOption[];
  customers: CustomerOption[];
}

export function PointsClient({
  initialExpiringLots,
  expiringError,
  initialNgPairs,
  ngError,
  therapists,
  customers,
}: Props) {
  // ---- Section 1: 残高照会 ----
  const [lookupInput, setLookupInput] = useState('');
  const [lookupResult, setLookupResult] = useState<{
    customerId: string;
    balance: number;
    entries: PointLedgerEntry[];
  } | null>(null);
  const [lookupError, setLookupError] = useState('');
  const [lookupPending, startLookupTransition] = useTransition();
  const [portalLink, setPortalLink] = useState<string | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pinPending, startPinTransition] = useTransition();

  function handleSetPin() {
    if (!lookupResult) return;
    if (!/^[0-9]{4,6}$/.test(pinInput)) {
      setPinMsg({ ok: false, text: '暗証番号は数字4〜6桁で入力してください' });
      return;
    }
    setPinMsg(null);
    startPinTransition(async () => {
      const res = await setCustomerPortalPin({ customerId: lookupResult.customerId, pin: pinInput });
      if (res.ok) {
        setPinInput('');
        setPinMsg({ ok: true, text: '暗証番号を設定しました。お客様は電話番号＋この番号で /member からログインできます。' });
      } else {
        setPinMsg({ ok: false, text: res.error ?? '設定に失敗しました' });
      }
    });
  }

  function handleLookup() {
    if (!lookupInput.trim()) return;
    setLookupError('');
    setLookupResult(null);
    setPortalLink(null);
    const isPhone = /^0[0-9]{9,10}$/.test(lookupInput.trim());
    const input = isPhone
      ? { phone: lookupInput.trim() }
      : { customerId: lookupInput.trim() };

    startLookupTransition(async () => {
      const res = await listPointLedger(input);
      if (res.ok && res.data) {
        setLookupResult(res.data);
        const link = await getCustomerPortalLink(input);
        if (link.ok && link.data) {
          setPortalLink(`${window.location.origin}${link.data.path}`);
        }
      } else {
        setLookupError(res.error ?? '照会に失敗しました');
      }
    });
  }

  // ---- Section 2: 手動付与 ----
  const [earnPhone, setEarnPhone] = useState('');
  const [earnCustomerId, setEarnCustomerId] = useState('');
  const [earnPointsStr, setEarnPointsStr] = useState('');
  const [earnReason, setEarnReason] = useState('');
  const [earnExpiresAt, setEarnExpiresAt] = useState('');
  const [earnMsg, setEarnMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [earnPending, startEarnTransition] = useTransition();

  function handleEarn() {
    const points = parseInt(earnPointsStr, 10);
    if (!Number.isInteger(points) || points <= 0) {
      setEarnMsg({ ok: false, text: 'ポイント数は正の整数で入力してください' });
      return;
    }
    if (!earnPhone && !earnCustomerId) {
      setEarnMsg({ ok: false, text: '電話番号または顧客IDを入力してください' });
      return;
    }
    setEarnMsg(null);
    startEarnTransition(async () => {
      const res = await earnPoints({
        ...(earnPhone ? { phone: earnPhone } : { customerId: earnCustomerId }),
        points,
        reason: earnReason || undefined,
        expiresAtISO: earnExpiresAt || undefined,
      });
      if (res.ok && res.data) {
        setEarnMsg({
          ok: true,
          text: `${points}P 付与しました（残高: ${res.data.balance}P）`,
        });
        setEarnPhone('');
        setEarnCustomerId('');
        setEarnPointsStr('');
        setEarnReason('');
        setEarnExpiresAt('');
      } else {
        setEarnMsg({ ok: false, text: res.error ?? '付与に失敗しました' });
      }
    });
  }

  // ---- Section 3: 失効一覧（初期データのみ / ページロード時に取得済み） ----
  const expiringLots = initialExpiringLots;
  const [expireMsg, setExpireMsg] = useState<string | null>(null);
  const [expirePending, startExpireTransition] = useTransition();

  // ---- Section 4: 指名NG ----
  const [ngPairs, setNgPairs] = useState<NgPairRow[]>(initialNgPairs);
  const [ngCustomerId, setNgCustomerId] = useState('');
  const [ngTherapistId, setNgTherapistId] = useState('');
  const [ngReason, setNgReason] = useState('');
  const [ngMsg, setNgMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ngPending, startNgTransition] = useTransition();

  function handleAddNg() {
    if (!ngCustomerId || !ngTherapistId) {
      setNgMsg({ ok: false, text: '顧客とセラピストを選択してください' });
      return;
    }
    setNgMsg(null);
    startNgTransition(async () => {
      const res = await addNgPair({
        customerId: ngCustomerId,
        therapistId: ngTherapistId,
        reason: ngReason || undefined,
      });
      if (res.ok) {
        // 一覧を再取得する代わりに楽観的に追加
        const c = customers.find((x) => x.id === ngCustomerId);
        const t = therapists.find((x) => x.id === ngTherapistId);
        if (c && t) {
          setNgPairs((prev) => [
            {
              customerId: ngCustomerId,
              therapistId: ngTherapistId,
              customerName: c.name,
              therapistName: t.name,
              reason: ngReason || null,
              createdAt: new Date().toISOString(),
            },
            ...prev.filter(
              (p) => !(p.customerId === ngCustomerId && p.therapistId === ngTherapistId),
            ),
          ]);
        }
        setNgCustomerId('');
        setNgTherapistId('');
        setNgReason('');
        setNgMsg({ ok: true, text: '指名NGを登録しました' });
      } else {
        setNgMsg({ ok: false, text: res.error ?? '登録に失敗しました' });
      }
    });
  }

  function handleRemoveNg(customerId: string, therapistId: string) {
    startNgTransition(async () => {
      const res = await removeNgPair({ customerId, therapistId });
      if (res.ok) {
        setNgPairs((prev) =>
          prev.filter((p) => !(p.customerId === customerId && p.therapistId === therapistId)),
        );
      } else {
        setNgMsg({ ok: false, text: res.error ?? '削除に失敗しました' });
      }
    });
  }

  return (
    <div className="space-y-10">

      {/* ===== Section 1: 残高照会 ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          残高照会
        </h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={lookupInput}
            onChange={(e) => setLookupInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleLookup(); }}
            placeholder="電話番号（0X0XXXXXXXX）または 顧客UUID"
            className="border border-adm-border rounded px-3 py-2 text-sm flex-1 focus:outline-none focus:border-adm-primary"
          />
          <button
            onClick={handleLookup}
            disabled={lookupPending}
            className="bg-adm-primary text-white px-4 py-2 rounded text-sm disabled:opacity-50"
          >
            {lookupPending ? '照会中…' : '照会'}
          </button>
        </div>

        {lookupError && (
          <p className="text-adm-error text-sm">{lookupError}</p>
        )}

        {lookupResult && (
          <div className="space-y-3">
            <div className="flex gap-4 items-baseline">
              <span className="text-sm text-adm-muted">現在残高</span>
              <span className="text-2xl font-bold text-adm-primary">
                {lookupResult.balance.toLocaleString()}P
              </span>
              <span className="text-xs text-adm-muted">顧客ID: {lookupResult.customerId}</span>
            </div>

            {portalLink && (
              <div className="flex flex-wrap items-center gap-2 rounded border border-adm-line bg-adm-bg p-2">
                <span className="text-xs text-adm-muted">顧客ページ（お客様に共有）:</span>
                <a href={portalLink} target="_blank" rel="noreferrer" className="text-xs text-adm-primary underline break-all">
                  {portalLink}
                </a>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(portalLink)}
                  className="text-xs px-2 py-0.5 rounded border border-adm-line text-adm-text"
                >
                  コピー
                </button>
              </div>
            )}

            {/* 会員ページの暗証番号（電話番号＋この番号でお客様がログイン） */}
            <div className="flex flex-wrap items-center gap-2 rounded border border-adm-line bg-adm-bg p-2">
              <span className="text-xs text-adm-muted">会員ページ暗証番号を設定:</span>
              <input
                inputMode="numeric"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="4〜6桁"
                maxLength={6}
                className="w-24 rounded border border-adm-line bg-white px-2 py-1 text-sm text-adm-text tabular-nums [color-scheme:light]"
              />
              <button
                type="button"
                onClick={handleSetPin}
                disabled={pinPending}
                className="text-xs px-3 py-1 rounded bg-adm-primary text-white disabled:opacity-50"
              >
                {pinPending ? '設定中…' : '設定'}
              </button>
              {pinMsg && (
                <span className={`text-xs ${pinMsg.ok ? 'text-adm-primary' : 'text-adm-danger'}`}>{pinMsg.text}</span>
              )}
            </div>

            {lookupResult.entries.length === 0 ? (
              <p className="text-sm text-adm-muted">台帳履歴はありません</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-adm-border text-adm-muted text-left">
                      <th className="py-1 pr-3">日時</th>
                      <th className="py-1 pr-3">種別</th>
                      <th className="py-1 pr-3 text-right">P数</th>
                      <th className="py-1 pr-3">理由</th>
                      <th className="py-1">失効日</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lookupResult.entries.map((e) => (
                      <tr key={e.id} className="border-b border-adm-border last:border-0">
                        <td className="py-1 pr-3 text-adm-muted">
                          {formatInTimeZone(new Date(e.occurredAt), TZ, 'MM/dd HH:mm')}
                        </td>
                        <td className="py-1 pr-3">
                          <span
                            className={
                              e.points > 0
                                ? 'text-adm-primary font-medium'
                                : 'text-adm-error font-medium'
                            }
                          >
                            {TYPE_LABEL[e.type] ?? e.type}
                          </span>
                        </td>
                        <td className="py-1 pr-3 text-right font-mono">
                          {e.points > 0 ? '+' : ''}{e.points.toLocaleString()}
                        </td>
                        <td className="py-1 pr-3 text-adm-muted max-w-xs truncate">
                          {e.reason ?? '—'}
                        </td>
                        <td className="py-1 text-adm-muted">
                          {e.expiresAt
                            ? formatInTimeZone(new Date(e.expiresAt), TZ, 'yyyy/MM/dd')
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {!lookupPending && !lookupResult && !lookupError && (
          <p className="text-sm text-adm-muted">電話番号または顧客IDを入力して照会してください</p>
        )}
      </section>

      {/* ===== Section 2: 手動付与 ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          手動付与
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-adm-muted mb-1">電話番号</label>
            <input
              type="text"
              value={earnPhone}
              onChange={(e) => { setEarnPhone(e.target.value); setEarnCustomerId(''); }}
              placeholder="0X0XXXXXXXX"
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
            />
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">顧客UUID（電話番号がない場合）</label>
            <input
              type="text"
              value={earnCustomerId}
              onChange={(e) => { setEarnCustomerId(e.target.value); setEarnPhone(''); }}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
            />
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">
              付与ポイント数（P）<span className="text-adm-error">*</span>
            </label>
            <input
              type="number"
              min="1"
              step="1"
              value={earnPointsStr}
              onChange={(e) => setEarnPointsStr(e.target.value)}
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
            />
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">失効日（未指定: CMS設定で自動算出）</label>
            <input
              type="date"
              value={earnExpiresAt ? earnExpiresAt.substring(0, 10) : ''}
              onChange={(e) =>
                setEarnExpiresAt(e.target.value ? `${e.target.value}T23:59:59+09:00` : '')
              }
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-adm-muted mb-1">理由（台帳に残ります）</label>
            <input
              type="text"
              value={earnReason}
              onChange={(e) => setEarnReason(e.target.value)}
              maxLength={200}
              placeholder="例: 周年特典・キャンペーン等"
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
            />
          </div>
        </div>

        {earnMsg && (
          <p className={`text-sm ${earnMsg.ok ? 'text-green-700' : 'text-adm-error'}`}>
            {earnMsg.text}
          </p>
        )}

        <button
          onClick={handleEarn}
          disabled={earnPending}
          className="bg-adm-primary text-white px-5 py-2 rounded text-sm disabled:opacity-50"
        >
          {earnPending ? '付与中…' : 'ポイントを付与する'}
        </button>
      </section>

      {/* ===== Section 3: 失効30日前一覧 ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2 flex items-center justify-between">
          <span>失効30日前のポイント（連絡要）</span>
          {/* 失効バッチの手動実行（cron はフェーズ20 / reviewer S2）。
              期限切れロットを expire 行で相殺し、残高を実態に合わせる。 */}
          <button
            type="button"
            onClick={() => {
              startExpireTransition(async () => {
                const res = await expirePoints();
                setExpireMsg(
                  res.ok
                    ? `失効処理を実行しました（${res.data?.expiredLotCount ?? 0}件 / ${res.data?.expiredPoints ?? 0}P）`
                    : res.error ?? '失効処理に失敗しました',
                );
                if (res.ok) location.reload();
              });
            }}
            disabled={expirePending}
            className="text-xs px-3 py-1 border border-adm-border rounded text-adm-text disabled:opacity-50"
          >
            {expirePending ? '実行中…' : '失効バッチを実行'}
          </button>
        </h2>

        {expireMsg && <p className="text-xs text-adm-muted">{expireMsg}</p>}

        {expiringError && (
          <p className="text-sm text-adm-error">{expiringError}</p>
        )}

        {!expiringError && expiringLots.length === 0 && (
          <p className="text-sm text-adm-muted">失効30日前のポイントはありません</p>
        )}

        {expiringLots.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-adm-border text-adm-muted text-left">
                  <th className="py-1 pr-3">失効日</th>
                  <th className="py-1 pr-3">顧客名</th>
                  <th className="py-1 pr-3">電話番号</th>
                  <th className="py-1 pr-3 text-right">残P</th>
                </tr>
              </thead>
              <tbody>
                {expiringLots.map((lot) => (
                  <tr
                    key={`${lot.customerId}-${lot.lotId}`}
                    className="border-b border-adm-border last:border-0"
                  >
                    <td className="py-1 pr-3 text-adm-warn font-medium">
                      {formatInTimeZone(lot.expiresAt, TZ, 'yyyy/MM/dd')}
                    </td>
                    <td className="py-1 pr-3">{lot.name}</td>
                    <td className="py-1 pr-3 font-mono">{lot.phone}</td>
                    <td className="py-1 pr-3 text-right font-bold">
                      {lot.remaining.toLocaleString()}P
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ===== Section 4: 指名NG管理 ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          指名NG管理
        </h2>
        <p className="text-xs text-adm-muted">
          登録済みのNG組合せは、全予約経路でDBガードが弾きます。ここでは staff が追加・削除のみ行います。
        </p>

        {/* 追加フォーム */}
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="block text-xs text-adm-muted mb-1">顧客</label>
            <select
              value={ngCustomerId}
              onChange={(e) => setNgCustomerId(e.target.value)}
              className="border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
            >
              <option value="">顧客を選択</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{c.phone}）
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">セラピスト</label>
            <select
              value={ngTherapistId}
              onChange={(e) => setNgTherapistId(e.target.value)}
              className="border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
            >
              <option value="">セラピストを選択</option>
              {therapists.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">理由（任意）</label>
            <input
              type="text"
              value={ngReason}
              onChange={(e) => setNgReason(e.target.value)}
              maxLength={500}
              className="border border-adm-border rounded px-3 py-2 text-sm w-48 focus:outline-none focus:border-adm-primary"
            />
          </div>
          <button
            onClick={handleAddNg}
            disabled={ngPending}
            className="bg-adm-warn text-white px-4 py-2 rounded text-sm disabled:opacity-50"
          >
            {ngPending ? '処理中…' : 'NG追加'}
          </button>
        </div>

        {ngMsg && (
          <p className={`text-sm ${ngMsg.ok ? 'text-green-700' : 'text-adm-error'}`}>
            {ngMsg.text}
          </p>
        )}

        {ngError && !ngMsg && (
          <p className="text-sm text-adm-error">{ngError}</p>
        )}

        {/* NG一覧 */}
        {ngPairs.length === 0 && !ngError && (
          <p className="text-sm text-adm-muted">登録済みの指名NGはありません</p>
        )}

        {ngPairs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-adm-border text-adm-muted text-left">
                  <th className="py-1 pr-3">顧客</th>
                  <th className="py-1 pr-3">セラピスト</th>
                  <th className="py-1 pr-3">理由</th>
                  <th className="py-1 pr-3">登録日</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {ngPairs.map((p) => (
                  <tr
                    key={`${p.customerId}-${p.therapistId}`}
                    className="border-b border-adm-border last:border-0"
                  >
                    <td className="py-1 pr-3">{p.customerName}</td>
                    <td className="py-1 pr-3">{p.therapistName}</td>
                    <td className="py-1 pr-3 text-adm-muted max-w-xs truncate">
                      {p.reason ?? '—'}
                    </td>
                    <td className="py-1 pr-3 text-adm-muted">
                      {formatInTimeZone(new Date(p.createdAt), TZ, 'yyyy/MM/dd')}
                    </td>
                    <td className="py-1">
                      <button
                        onClick={() => handleRemoveNg(p.customerId, p.therapistId)}
                        disabled={ngPending}
                        className="text-adm-error text-xs underline disabled:opacity-50"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
