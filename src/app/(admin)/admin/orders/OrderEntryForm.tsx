'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  searchCustomerByPhone,
  searchHotels,
  createLostOrder,
  createPhoneOrder,
} from './actions';
import type { OrderFormData } from './actions';

interface Therapist {
  id: string;
  slug: string;
  name: string;
}

interface Course {
  id: string;
  name: string;
  duration_min: number;
  price: number;
  nomination_fee_default: number;
}

interface Option {
  id: string;
  name: string;
  price: number;
  duration_min: number;
}

interface Area {
  id: string;
  name: string;
}

interface Props {
  therapists: Therapist[];
  courses: Course[];
  options: Option[];
  areas: Area[];
}

type LostReason = 'time' | 'area' | 'nomination' | 'price' | 'other';

const LOST_REASON_LABELS: Record<LostReason, string> = {
  time: '時間が合わない',
  area: 'エリア外',
  nomination: '指名不可',
  price: '料金',
  other: 'その他',
};

export default function OrderEntryForm({ therapists, courses, options, areas }: Props) {
  // Form state
  const [phone, setPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [destinationType, setDestinationType] = useState<'home' | 'hotel'>('home');
  const [addressDetail, setAddressDetail] = useState('');
  const [areaId, setAreaId] = useState('');
  const [hotelQuery, setHotelQuery] = useState('');
  const [hotelId, setHotelId] = useState('');
  const [hotelSuggestions, setHotelSuggestions] = useState<{ id: string; name: string }[]>([]);
  const [roomNumber, setRoomNumber] = useState('');
  const [therapistId, setTherapistId] = useState('');
  const [courseId, setCourseId] = useState(courses[0]?.id ?? '');
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [startAtISO, setStartAtISO] = useState('');
  const [preferences, setPreferences] = useState('');

  // UI state
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [customerLookupMsg, setCustomerLookupMsg] = useState('');
  const [showLostDialog, setShowLostDialog] = useState(false);
  const [lostReason, setLostReason] = useState<LostReason | ''>('');
  const [lostNote, setLostNote] = useState('');
  const [lostLoading, setLostLoading] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [showOverride, setShowOverride] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Price calculation
  const selectedCourse = courses.find((c) => c.id === courseId);
  const selectedOptions = options.filter((o) => selectedOptionIds.includes(o.id));
  const coursePrice = selectedCourse?.price ?? 0;
  const optionTotal = selectedOptions.reduce((sum, o) => sum + o.price, 0);
  const nominationFee = therapistId ? (selectedCourse?.nomination_fee_default ?? 0) : 0;
  const transportFee = 0; // Simplified - would come from area settings
  const totalAmount = coursePrice + optionTotal + nominationFee + transportFee;

  // Phone lookup with debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!/^0[0-9]{9,10}$/.test(phone)) {
      setCustomerLookupMsg('');
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const result = await searchCustomerByPhone(phone);
      if (result.ok && result.data) {
        const c = result.data;
        setCustomerName((prev) => prev || c.name);
        if (c.addressDetail) setAddressDetail((prev) => prev || (c.addressDetail ?? ''));
        if (c.areaId) setAreaId((prev) => prev || (c.areaId ?? ''));
        setCustomerLookupMsg(`リピーター（${c.name}様）の情報を自動入力しました`);
      } else {
        setCustomerLookupMsg('');
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [phone]);

  // Hotel search
  const handleHotelSearch = useCallback(async (q: string) => {
    setHotelQuery(q);
    if (q.trim().length < 1) {
      setHotelSuggestions([]);
      return;
    }
    const result = await searchHotels(q);
    if (result.ok && result.data) {
      setHotelSuggestions(result.data.map((h) => ({ id: h.id, name: h.name })));
    }
  }, []);

  const toggleOption = (optId: string) => {
    setSelectedOptionIds((prev) =>
      prev.includes(optId) ? prev.filter((id) => id !== optId) : [...prev, optId],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    const formData: OrderFormData = {
      phone,
      customerName,
      destinationType,
      addressDetail: addressDetail || undefined,
      areaId: areaId || undefined,
      hotelId: hotelId || undefined,
      roomNumber: roomNumber || undefined,
      therapistId: therapistId || undefined,
      courseId,
      optionIds: selectedOptionIds,
      startAtISO,
      preferences: preferences || undefined,
      nominationFee,
      transportFee,
      totalAmount,
      overrideReason: overrideReason || undefined,
    };

    const result = await createPhoneOrder(formData);
    setLoading(false);

    if (result.ok) {
      setSuccessMsg(`予約が完了しました（ID: ${result.data?.reservationId ?? ''}）`);
      // Reset form
      setPhone('');
      setCustomerName('');
      setAddressDetail('');
      setAreaId('');
      setHotelId('');
      setHotelQuery('');
      setRoomNumber('');
      setTherapistId('');
      setCourseId(courses[0]?.id ?? '');
      setSelectedOptionIds([]);
      setStartAtISO('');
      setPreferences('');
      setOverrideReason('');
      setCustomerLookupMsg('');
    } else {
      setErrorMsg(result.error ?? '予約の作成に失敗しました');
    }
  };

  const handleLostOrder = async () => {
    if (!lostReason) return;
    setLostLoading(true);
    const result = await createLostOrder({
      phone: phone || undefined,
      areaId: areaId || undefined,
      reason: lostReason,
      note: lostNote || undefined,
    });
    setLostLoading(false);
    if (result.ok) {
      setShowLostDialog(false);
      setLostReason('');
      setLostNote('');
      setSuccessMsg('不成立ログを記録しました');
    } else {
      setErrorMsg(result.error ?? '不成立ログの記録に失敗しました');
    }
  };

  return (
    <div className="space-y-6">
      {/* Fixed price summary bar */}
      <div className="sticky top-0 z-10 bg-adm-surface border border-adm-border rounded p-4 flex items-center justify-between shadow-sm">
        <div className="flex gap-6 text-sm">
          <span>コース: <strong>{coursePrice.toLocaleString()}円</strong></span>
          {optionTotal > 0 && <span>オプション: <strong>{optionTotal.toLocaleString()}円</strong></span>}
          {nominationFee > 0 && <span>指名料: <strong>{nominationFee.toLocaleString()}円</strong></span>}
        </div>
        <div className="text-lg font-bold text-adm-primary">
          合計: {totalAmount.toLocaleString()}円
        </div>
      </div>

      {successMsg && (
        <div className="bg-green-50 border border-green-200 text-green-800 rounded p-3 text-sm">
          {successMsg}
        </div>
      )}
      {errorMsg && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* 電話番号 */}
        <div>
          <label className="block text-sm font-medium text-adm-text mb-1">
            電話番号
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="09012345678"
            className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
            tabIndex={1}
          />
          {customerLookupMsg && (
            <p className="text-xs text-adm-primary mt-1">{customerLookupMsg}</p>
          )}
        </div>

        {/* お名前 */}
        <div>
          <label className="block text-sm font-medium text-adm-text mb-1">
            お名前（お呼びしてよい名前）
          </label>
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="例: 田中様"
            className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
            tabIndex={2}
            required
          />
        </div>

        {/* 派遣先タイプ */}
        <div>
          <label className="block text-sm font-medium text-adm-text mb-1">
            派遣先
          </label>
          <div className="flex gap-4">
            {(['home', 'hotel'] as const).map((type) => (
              <label key={type} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="destinationType"
                  value={type}
                  checked={destinationType === type}
                  onChange={() => setDestinationType(type)}
                  tabIndex={3}
                />
                <span className="text-sm">{type === 'home' ? '住居・自宅' : 'ホテル'}</span>
              </label>
            ))}
          </div>
        </div>

        {/* 住居の場合 */}
        {destinationType === 'home' && (
          <>
            <div>
              <label className="block text-sm font-medium text-adm-text mb-1">住所</label>
              <input
                type="text"
                value={addressDetail}
                onChange={(e) => setAddressDetail(e.target.value)}
                placeholder="東京都渋谷区〇〇 1-2-3 △△マンション 101号室"
                className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
                tabIndex={4}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-adm-text mb-1">エリア</label>
              <select
                value={areaId}
                onChange={(e) => setAreaId(e.target.value)}
                className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
                tabIndex={5}
              >
                <option value="">エリアを選択</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* ホテルの場合 */}
        {destinationType === 'hotel' && (
          <>
            <div className="relative">
              <label className="block text-sm font-medium text-adm-text mb-1">ホテル名</label>
              <input
                type="text"
                value={hotelQuery}
                onChange={(e) => handleHotelSearch(e.target.value)}
                placeholder="ホテル名を入力（予測入力）"
                className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
                tabIndex={4}
              />
              {hotelSuggestions.length > 0 && (
                <ul className="absolute z-20 w-full bg-adm-surface border border-adm-border rounded mt-1 shadow">
                  {hotelSuggestions.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm hover:bg-adm-bg"
                        onClick={() => {
                          setHotelId(h.id);
                          setHotelQuery(h.name);
                          setHotelSuggestions([]);
                        }}
                      >
                        {h.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-adm-text mb-1">部屋番号</label>
              <input
                type="text"
                value={roomNumber}
                onChange={(e) => setRoomNumber(e.target.value)}
                placeholder="例: 1234"
                className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
                tabIndex={5}
              />
            </div>
          </>
        )}

        {/* セラピスト指名 */}
        <div>
          <label className="block text-sm font-medium text-adm-text mb-1">セラピスト指名</label>
          <select
            value={therapistId}
            onChange={(e) => setTherapistId(e.target.value)}
            className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
            tabIndex={6}
          >
            <option value="">対応可能な人（指名なし）</option>
            {therapists.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        {/* コース */}
        <div>
          <label className="block text-sm font-medium text-adm-text mb-1">コース</label>
          <select
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
            className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
            tabIndex={7}
          >
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.duration_min}分 {c.price.toLocaleString()}円
              </option>
            ))}
          </select>
        </div>

        {/* オプション */}
        {options.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-adm-text mb-1">オプション</label>
            <div className="space-y-2">
              {options.map((o, idx) => (
                <label key={o.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedOptionIds.includes(o.id)}
                    onChange={() => toggleOption(o.id)}
                    tabIndex={8 + idx}
                  />
                  <span className="text-sm">
                    {o.name} +{o.price.toLocaleString()}円
                    {o.duration_min > 0 && ` (+${o.duration_min}分)`}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* 希望日時 */}
        <div>
          <label className="block text-sm font-medium text-adm-text mb-1">希望日時</label>
          <input
            type="datetime-local"
            value={startAtISO.replace('Z', '').slice(0, 16)}
            onChange={(e) => setStartAtISO(e.target.value ? new Date(e.target.value).toISOString() : '')}
            className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
            tabIndex={9 + options.length}
            required
          />
        </div>

        {/* お好み・備考 */}
        <div>
          <label className="block text-sm font-medium text-adm-text mb-1">お好み・備考</label>
          <textarea
            value={preferences}
            onChange={(e) => setPreferences(e.target.value)}
            placeholder="強さのご希望、苦手な部位、注意事項など"
            rows={3}
            className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary resize-none"
            tabIndex={10 + options.length}
          />
        </div>

        {/* 枠外予約（管理者権限） */}
        <div>
          <button
            type="button"
            onClick={() => setShowOverride(!showOverride)}
            className="text-xs text-adm-muted underline"
            tabIndex={11 + options.length}
          >
            枠外予約（管理者のみ）
          </button>
          {showOverride && (
            <div className="mt-2">
              <input
                type="text"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="枠外予約の理由（必須）"
                className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
                tabIndex={12 + options.length}
              />
            </div>
          )}
        </div>

        {/* ボタン */}
        <div className="flex gap-3 pt-4 border-t border-adm-border">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-adm-primary text-white rounded px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            tabIndex={13 + options.length}
          >
            {loading ? '処理中…' : '予約する'}
          </button>
          <button
            type="button"
            onClick={() => setShowLostDialog(true)}
            className="px-4 py-2 border border-adm-border rounded text-sm text-adm-text hover:bg-adm-bg transition-colors"
            tabIndex={14 + options.length}
          >
            不成立
          </button>
        </div>
      </form>

      {/* 不成立ダイアログ */}
      {showLostDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-adm-surface rounded shadow-lg p-6 w-full max-w-sm mx-4">
            <h2 className="text-base font-semibold text-adm-text mb-4">不成立ログを記録</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-adm-text mb-1">
                  理由 <span className="text-red-500">*</span>
                </label>
                <div className="space-y-2">
                  {(Object.entries(LOST_REASON_LABELS) as [LostReason, string][]).map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="lostReason"
                        value={value}
                        checked={lostReason === value}
                        onChange={() => setLostReason(value)}
                      />
                      <span className="text-sm">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-adm-text mb-1">メモ</label>
                <textarea
                  value={lostNote}
                  onChange={(e) => setLostNote(e.target.value)}
                  rows={2}
                  className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary resize-none"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={handleLostOrder}
                disabled={!lostReason || lostLoading}
                className="flex-1 bg-adm-primary text-white rounded px-3 py-2 text-sm font-medium disabled:opacity-50"
              >
                {lostLoading ? '記録中…' : '記録する'}
              </button>
              <button
                onClick={() => { setShowLostDialog(false); setLostReason(''); setLostNote(''); }}
                className="px-3 py-2 border border-adm-border rounded text-sm text-adm-text hover:bg-adm-bg"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
