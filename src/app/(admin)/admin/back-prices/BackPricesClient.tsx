'use client';

/**
 * バック単価表クライアントコンポーネント。
 * コース・オプション・指名の固定バック単価をインライン編集し、
 * upsertPayoutRate（既存 Server Action）で保存する。
 * canWrite=false のときは閲覧のみ（保存ボタン非表示）。
 */

import { useState, useTransition } from 'react';
import { upsertPayoutRate } from '@/lib/payout/actions';
import type { BackPriceCourse, BackPriceOption } from '@/lib/payout/back-prices-actions';

interface Props {
  courses: BackPriceCourse[];
  options: BackPriceOption[];
  nominationBackYen: number | null;
  canWrite: boolean;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function RateCell({
  currentYen,
  canWrite,
  onSave,
}: {
  currentYen: number | null;
  canWrite: boolean;
  onSave: (yen: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(String(currentYen ?? ''));
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const handleSave = () => {
    const val = parseInt(input, 10);
    if (!Number.isInteger(val) || val < 0) {
      setMsg({ ok: false, text: '0以上の整数（円）を入力してください' });
      return;
    }
    startTransition(async () => {
      try {
        await onSave(val);
        setMsg({ ok: true, text: '保存しました' });
        setEditing(false);
        setTimeout(() => setMsg(null), 2000);
      } catch {
        setMsg({ ok: false, text: '保存に失敗しました' });
      }
    });
  };

  return (
    <div className="flex items-center gap-2">
      {editing && canWrite ? (
        <>
          <input
            type="number"
            min="0"
            step="1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="border border-adm-border rounded px-2 py-1 text-sm w-28 font-mono focus:outline-none focus:ring-1 focus:ring-adm-primary"
            autoFocus
          />
          <span className="text-xs text-adm-muted">円</span>
          <button
            onClick={handleSave}
            disabled={isPending}
            className="px-3 py-1 bg-adm-primary text-white text-xs rounded hover:opacity-90 disabled:opacity-50"
          >
            {isPending ? '保存中…' : '保存'}
          </button>
          <button
            onClick={() => { setEditing(false); setMsg(null); }}
            className="px-2 py-1 border border-adm-border text-xs rounded text-adm-text hover:bg-adm-bg"
          >
            キャンセル
          </button>
        </>
      ) : (
        <>
          <span className="font-mono font-bold text-adm-text">
            {currentYen !== null ? `¥${currentYen.toLocaleString('ja-JP')}` : '—'}
          </span>
          {canWrite && (
            <button
              onClick={() => { setInput(String(currentYen ?? '')); setEditing(true); setMsg(null); }}
              className="text-xs text-adm-primary underline hover:opacity-70"
            >
              編集
            </button>
          )}
        </>
      )}
      {msg && (
        <span className={`text-xs ${msg.ok ? 'text-adm-primary' : 'text-adm-danger'}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

export default function BackPricesClient({ courses, options, nominationBackYen, canWrite }: Props) {
  const effectiveFrom = today();

  const saveCourseRate = async (courseId: string, yen: number) => {
    const result = await upsertPayoutRate({
      therapistId: null,
      rankId: null,
      targetType: 'course',
      targetId: courseId,
      calcType: 'fixed',
      value: yen,
      effectiveFrom,
      note: 'バック単価表から更新',
    });
    if (!result.ok) throw new Error(result.error ?? '保存エラー');
  };

  const saveOptionRate = async (optionId: string, yen: number) => {
    const result = await upsertPayoutRate({
      therapistId: null,
      rankId: null,
      targetType: 'option',
      targetId: optionId,
      calcType: 'fixed',
      value: yen,
      effectiveFrom,
      note: 'バック単価表から更新',
    });
    if (!result.ok) throw new Error(result.error ?? '保存エラー');
  };

  const saveNominationRate = async (yen: number) => {
    const result = await upsertPayoutRate({
      therapistId: null,
      rankId: null,
      targetType: 'nomination',
      targetId: null,
      calcType: 'fixed',
      value: yen,
      effectiveFrom,
      note: 'バック単価表から更新',
    });
    if (!result.ok) throw new Error(result.error ?? '保存エラー');
  };

  return (
    <div className="space-y-8">
      {/* 指名バック */}
      <section>
        <h2 className="text-sm font-bold text-adm-text border-b border-adm-border pb-1 mb-3">
          指名バック
        </h2>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-adm-border bg-adm-bg">
              <th className="text-left py-1.5 px-3 text-xs text-adm-muted font-bold">区分</th>
              <th className="text-right py-1.5 px-3 text-xs text-adm-muted font-bold">バック単価</th>
              {canWrite && <th className="w-24" />}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-adm-border">
              <td className="py-2 px-3 text-adm-text">指名バック（デフォルト）</td>
              <td className="py-2 px-3 text-right">
                <RateCell
                  currentYen={nominationBackYen}
                  canWrite={canWrite}
                  onSave={saveNominationRate}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* コース別バック */}
      <section>
        <h2 className="text-sm font-bold text-adm-text border-b border-adm-border pb-1 mb-3">
          コース別バック単価
        </h2>
        {courses.length === 0 ? (
          <p className="text-xs text-adm-muted py-4">有効なコースがありません</p>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-adm-border bg-adm-bg">
                <th className="text-left py-1.5 px-3 text-xs text-adm-muted font-bold">コース</th>
                <th className="text-right py-1.5 px-3 text-xs text-adm-muted font-bold">コース料金</th>
                <th className="text-right py-1.5 px-3 text-xs text-adm-muted font-bold">バック単価</th>
              </tr>
            </thead>
            <tbody>
              {courses.map((course) => (
                <tr key={course.id} className="border-b border-adm-border hover:bg-adm-bg">
                  <td className="py-2 px-3 text-adm-text">
                    {course.name}
                    <span className="ml-2 text-xs text-adm-muted">{course.durationMin}分</span>
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-adm-muted text-xs">
                    ¥{course.price.toLocaleString('ja-JP')}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <RateCell
                      currentYen={course.backYen}
                      canWrite={canWrite}
                      onSave={(yen) => saveCourseRate(course.id, yen)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* オプション別バック */}
      <section>
        <h2 className="text-sm font-bold text-adm-text border-b border-adm-border pb-1 mb-3">
          オプション別バック単価
        </h2>
        {options.length === 0 ? (
          <p className="text-xs text-adm-muted py-4">有効なオプションがありません</p>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-adm-border bg-adm-bg">
                <th className="text-left py-1.5 px-3 text-xs text-adm-muted font-bold">オプション</th>
                <th className="text-right py-1.5 px-3 text-xs text-adm-muted font-bold">オプション料金</th>
                <th className="text-right py-1.5 px-3 text-xs text-adm-muted font-bold">バック単価</th>
              </tr>
            </thead>
            <tbody>
              {options.map((option) => (
                <tr key={option.id} className="border-b border-adm-border hover:bg-adm-bg">
                  <td className="py-2 px-3 text-adm-text">
                    {option.name}
                    {option.durationMin > 0 && (
                      <span className="ml-2 text-xs text-adm-muted">+{option.durationMin}分</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-adm-muted text-xs">
                    ¥{option.price.toLocaleString('ja-JP')}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <RateCell
                      currentYen={option.backYen}
                      canWrite={canWrite}
                      onSave={(yen) => saveOptionRate(option.id, yen)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {!canWrite && (
        <p className="text-xs text-adm-muted border-t border-adm-border pt-4">
          ※ 単価の編集はオーナー/管理者のみ実行できます。
        </p>
      )}
    </div>
  );
}
