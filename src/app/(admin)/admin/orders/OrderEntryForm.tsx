'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  searchCustomerByPhone,
  searchHotels,
  createLostOrder,
  createPhoneOrder,
  getAvailableTherapists,
  registerProvisionalHotel,
} from './actions';
import type { OrderFormData, AvailableTherapistOption } from './actions';
import type { PublicSlotView } from '@/lib/availability/public-slots';
import { getPointBalance, usePoints as spendPoints } from '@/lib/points/actions';

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
  const [hotelNotFound, setHotelNotFound] = useState(false);
  const [roomNumber, setRoomNumber] = useState('');
  const [courseId, setCourseId] = useState(courses[0]?.id ?? '');
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [preferences, setPreferences] = useState('');

  // セラピスト選択（候補セレクタ）
  // 'any' = 誰でもいい（候補を検索）, '' = 未選択, それ以外 = therapist.id
  const [therapistSelectMode, setTherapistSelectMode] = useState<'any' | 'specific'>('specific');
  const [selectedTherapistId, setSelectedTherapistId] = useState('');
  const [selectedTherapistSlug, setSelectedTherapistSlug] = useState('');
  const [selectedStartAtISO, setSelectedStartAtISO] = useState('');
  const [dateISO, setDateISO] = useState('');

  // 候補リスト（getAvailableTherapists の結果）
  const [candidateTherapists, setCandidateTherapists] = useState<AvailableTherapistOption[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState('');

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
  const [provisionalHotelLoading, setProvisionalHotelLoading] = useState(false);

  // ポイント関連 state
  const [customerPointBalance, setCustomerPointBalance] = useState<number | null>(null);
  const [confirmedReservationId, setConfirmedReservationId] = useState<string | null>(null);
  const [pointUseDone, setPointUseDone] = useState(false);
  const [confirmedCustomerPhone, setConfirmedCustomerPhone] = useState<string | null>(null);
  const [usePointsInput, setUsePointsInput] = useState('');
  const [usePointsMsg, setUsePointsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [usePointsLoading, setUsePointsLoading] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candidateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Price calculation（表示用のみ。サーバ側が正）
  const selectedCourse = courses.find((c) => c.id === courseId);
  const selectedOptions = options.filter((o) => selectedOptionIds.includes(o.id));
  const coursePrice = selectedCourse?.price ?? 0;
  const optionTotal = selectedOptions.reduce((sum, o) => sum + o.price, 0);
  const nominationFee = selectedTherapistId ? (selectedCourse?.nomination_fee_default ?? 0) : 0;
  const transportFee = 0; // 表示用（サーバ側で計算）
  const totalAmount = coursePrice + optionTotal + nominationFee + transportFee;

  // Phone lookup with debounce（推奨9: note を preferences に自動補完）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!/^0[0-9]{9,10}$/.test(phone)) {
      setCustomerLookupMsg('');
      setCustomerPointBalance(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const result = await searchCustomerByPhone(phone);
      if (result.ok && result.data) {
        const c = result.data;
        setCustomerName((prev) => prev || c.name);
        if (c.addressDetail) setAddressDetail((prev) => prev || (c.addressDetail ?? ''));
        if (c.areaId) setAreaId((prev) => prev || (c.areaId ?? ''));
        // 推奨9: note を preferences に自動補完
        if (c.note) setPreferences((prev) => prev || (c.note ?? ''));
        setCustomerLookupMsg(`リピーター（${c.name}様）の情報を自動入力しました`);
        // ポイント残高を電話番号で取得
        void getPointBalance({ phone }).then((balRes) => {
          if (balRes.ok && balRes.data) {
            setCustomerPointBalance(balRes.data.balance);
          } else {
            setCustomerPointBalance(null);
          }
        });
      } else {
        setCustomerLookupMsg('');
        setCustomerPointBalance(null);
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [phone]);

  // 候補セラピスト取得（エリア/コース/オプション/日付が確定したら自動呼び出し）
  const fetchCandidates = useCallback(async () => {
    if (!courseId || !dateISO) {
      setCandidateTherapists([]);
      return;
    }
    setCandidatesLoading(true);
    setCandidatesError('');
    try {
      const result = await getAvailableTherapists({
        dateISO,
        areaId: areaId || undefined,
        hotelId: hotelId || undefined,
        courseId,
        optionIds: selectedOptionIds.length > 0 ? selectedOptionIds : undefined,
      });
      if (result.ok && result.data) {
        setCandidateTherapists(result.data);
        if (result.data.length === 0) {
          setCandidatesError('この条件で対応可能なセラピストが見つかりません');
        }
      } else {
        setCandidatesError(result.error ?? '候補の取得に失敗しました');
      }
    } catch {
      setCandidatesError('候補の取得中にエラーが発生しました');
    } finally {
      setCandidatesLoading(false);
    }
  }, [courseId, dateISO, areaId, hotelId, selectedOptionIds]);

  // 候補を取得するトリガー（デバウンス）
  useEffect(() => {
    if (candidateDebounceRef.current) clearTimeout(candidateDebounceRef.current);
    if (therapistSelectMode === 'any' || therapistSelectMode === 'specific') {
      candidateDebounceRef.current = setTimeout(() => {
        void fetchCandidates();
      }, 300);
    }
    return () => {
      if (candidateDebounceRef.current) clearTimeout(candidateDebounceRef.current);
    };
  }, [fetchCandidates, therapistSelectMode]);

  // Hotel search
  const handleHotelSearch = useCallback(async (q: string) => {
    setHotelQuery(q);
    setHotelNotFound(false);
    if (q.trim().length < 1) {
      setHotelSuggestions([]);
      return;
    }
    const result = await searchHotels(q);
    if (result.ok && result.data) {
      setHotelSuggestions(result.data.map((h) => ({ id: h.id, name: h.name })));
      if (result.data.length === 0 && q.trim().length > 0) {
        setHotelNotFound(true);
      }
    }
  }, []);

  const handleProvisionalHotel = async () => {
    if (!hotelQuery.trim()) return;
    setProvisionalHotelLoading(true);
    const result = await registerProvisionalHotel(hotelQuery.trim());
    setProvisionalHotelLoading(false);
    if (result.ok && result.data) {
      setHotelId(result.data.id);
      setHotelQuery(result.data.name);
      setHotelSuggestions([]);
      setHotelNotFound(false);
    } else {
      setErrorMsg(result.error ?? '仮登録に失敗しました');
    }
  };

  const toggleOption = (optId: string) => {
    setSelectedOptionIds((prev) =>
      prev.includes(optId) ? prev.filter((id) => id !== optId) : [...prev, optId],
    );
  };

  // セラピスト + 枠 の選択
  const handleSlotSelect = (therapist: AvailableTherapistOption, slot: PublicSlotView) => {
    setSelectedTherapistId(therapist.id);
    setSelectedTherapistSlug(therapist.slug);
    setSelectedStartAtISO(slot.startAtISO);
  };

  const handleSpecificTherapistChange = (tId: string) => {
    setSelectedTherapistId(tId);
    const found = therapists.find((t) => t.id === tId);
    setSelectedTherapistSlug(found?.slug ?? '');
    setSelectedStartAtISO('');
  };

  const resetForm = () => {
    setPhone('');
    setCustomerName('');
    setAddressDetail('');
    setAreaId('');
    setHotelId('');
    setHotelQuery('');
    setRoomNumber('');
    setSelectedTherapistId('');
    setSelectedTherapistSlug('');
    setSelectedStartAtISO('');
    setDateISO('');
    setCourseId(courses[0]?.id ?? '');
    setSelectedOptionIds([]);
    setPreferences('');
    setOverrideReason('');
    setCustomerLookupMsg('');
    setCandidateTherapists([]);
    setTherapistSelectMode('specific');
    setHotelNotFound(false);
    // ポイント state は確定後フローで使うため、confirmedReservationId/Phone は
    // handleUsePoints 完了後か次の注文開始時（successMsg クリア）にリセットする。
    // フォーム項目だけリセット。
    setCustomerPointBalance(null);
    setUsePointsInput('');
    setUsePointsMsg(null);
    // confirmedReservationId / confirmedCustomerPhone は resetForm ではクリアしない
    // （successMsg に紐づくポイント利用UIが残るため）。
    // 次の「予約する」でhandleSubmitが走るときにクリアする。
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    // 前回の確定情報をクリア
    setConfirmedReservationId(null);
    setConfirmedCustomerPhone(null);
    setUsePointsInput('');
    setUsePointsMsg(null);

    // セラピスト必須チェック
    if (!selectedTherapistId || !selectedTherapistSlug) {
      setErrorMsg('候補セラピストを選択してください');
      setLoading(false);
      return;
    }
    if (!selectedStartAtISO) {
      setErrorMsg('利用開始時間を選択してください');
      setLoading(false);
      return;
    }

    const formData: OrderFormData = {
      phone,
      customerName,
      destinationType,
      addressDetail: addressDetail || undefined,
      areaId: areaId || undefined,
      hotelId: hotelId || undefined,
      roomNumber: roomNumber || undefined,
      therapistId: selectedTherapistId,
      therapistSlug: selectedTherapistSlug,
      courseId,
      optionIds: selectedOptionIds,
      startAtISO: selectedStartAtISO,
      preferences: preferences || undefined,
      overrideReason: overrideReason || undefined,
    };

    const result = await createPhoneOrder(formData);
    setLoading(false);

    if (result.ok) {
      const resId = result.data?.reservationId ?? null;
      const phoneForPoints = phone; // ポイント利用のために保持（resetForm で上書きされる前に取得）
      setSuccessMsg(`予約が完了しました（ID: ${resId ?? ''}）`);
      setConfirmedReservationId(resId);
      setConfirmedCustomerPhone(phoneForPoints);
      resetForm();
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

  /**
   * 確定済み予約へのポイント利用（確定後フロー）。
   * confirmedCustomerPhone を使って顧客を特定する。
   * 会計への実値引きはフェーズ17で実装。ここでは台帳記録のみ。
   */
  const handleUsePoints = async () => {
    const requested = parseInt(usePointsInput, 10);
    if (!Number.isInteger(requested) || requested <= 0) {
      setUsePointsMsg({ ok: false, text: 'ポイント数を正の整数で入力してください' });
      return;
    }
    if (!confirmedReservationId) {
      setUsePointsMsg({ ok: false, text: '予約IDが見つかりません' });
      return;
    }
    if (!confirmedCustomerPhone) {
      setUsePointsMsg({ ok: false, text: '電話番号が取得できません。ポイント管理画面から手動で操作してください' });
      return;
    }
    setUsePointsLoading(true);
    setUsePointsMsg(null);
    const res = await spendPoints({
      phone: confirmedCustomerPhone,
      requestedPoints: requested,
      reservationId: confirmedReservationId,
      reason: '電話注文ポイント利用',
    });
    setUsePointsLoading(false);
    if (res.ok && res.data) {
      setUsePointsMsg({
        ok: true,
        text: `${res.data.used}P 利用を台帳に記録しました（残高: ${res.data.balance}P）。会計の値引きはフェーズ17で反映されます。`,
      });
      setCustomerPointBalance(res.data.balance);
      // 同一予約への二重記録を防ぐ（成功後は入力を締める / reviewer S3）
      setPointUseDone(true);
    } else {
      setUsePointsMsg({ ok: false, text: res.error ?? 'ポイント利用に失敗しました' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Fixed price summary bar（表示用のみ / サーバ側が正） */}
      <div className="sticky top-0 z-10 bg-adm-surface border border-adm-border rounded p-4 flex items-center justify-between shadow-sm">
        <div className="flex gap-6 text-sm">
          <span>コース: <strong>{coursePrice.toLocaleString()}円</strong></span>
          {optionTotal > 0 && <span>オプション: <strong>{optionTotal.toLocaleString()}円</strong></span>}
          {nominationFee > 0 && <span>指名料: <strong>{nominationFee.toLocaleString()}円</strong></span>}
          <span className="text-xs text-adm-muted">※金額はサーバ側で再計算</span>
        </div>
        <div className="text-lg font-bold text-adm-primary">
          参考合計: {totalAmount.toLocaleString()}円
        </div>
      </div>

      {successMsg && (
        <div className="bg-green-50 border border-green-200 text-green-800 rounded p-3 text-sm space-y-2">
          <p>{successMsg}</p>
          {confirmedReservationId && confirmedCustomerPhone && (
            <div className="pt-2 border-t border-green-200">
              <p className="text-xs text-green-700 mb-2">
                ポイントを利用する場合は以下に入力してください。
                <span className="font-medium">
                  会計への値引き反映はフェーズ17で対応します。
                </span>
              </p>
              <div className="flex gap-2 items-center flex-wrap">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={usePointsInput}
                  onChange={(e) => setUsePointsInput(e.target.value)}
                  placeholder="利用P数"
                  disabled={pointUseDone}
                  className="border border-green-300 rounded px-2 py-1 text-sm w-28 focus:outline-none disabled:opacity-50"
                />
                {customerPointBalance !== null && (
                  <span className="text-xs text-green-700">
                    （残高: {customerPointBalance.toLocaleString()}P）
                  </span>
                )}
                <button
                  onClick={() => { void handleUsePoints(); }}
                  disabled={usePointsLoading || pointUseDone}
                  className="bg-green-700 text-white px-3 py-1 rounded text-xs disabled:opacity-50"
                >
                  {usePointsLoading ? '記録中…' : pointUseDone ? '記録済み' : '利用を記録'}
                </button>
              </div>
              {usePointsMsg && (
                <p className={`text-xs mt-1 ${usePointsMsg.ok ? 'text-green-700' : 'text-red-600'}`}>
                  {usePointsMsg.text}
                </p>
              )}
            </div>
          )}
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
          {customerPointBalance !== null && (
            <p className="text-xs text-adm-primary font-medium mt-0.5">
              ポイント残高: {customerPointBalance.toLocaleString()}P
            </p>
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
                onChange={(e) => { void handleHotelSearch(e.target.value); }}
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
                          setHotelNotFound(false);
                        }}
                      >
                        {h.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {/* 推奨11: 検索結果0件時に仮登録ボタン */}
              {hotelNotFound && hotelQuery.trim().length > 0 && (
                <div className="mt-2">
                  <span className="text-xs text-adm-muted">ホテルが見つかりません。</span>
                  <button
                    type="button"
                    onClick={() => { void handleProvisionalHotel(); }}
                    disabled={provisionalHotelLoading}
                    className="ml-2 text-xs text-adm-primary underline disabled:opacity-50"
                  >
                    {provisionalHotelLoading ? '登録中…' : '「' + hotelQuery + '」を仮登録する'}
                  </button>
                </div>
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

        {/* コース */}
        <div>
          <label className="block text-sm font-medium text-adm-text mb-1">コース</label>
          <select
            value={courseId}
            onChange={(e) => {
              setCourseId(e.target.value);
              setSelectedStartAtISO('');
            }}
            className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
            tabIndex={6}
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
                    onChange={() => {
                      toggleOption(o.id);
                      setSelectedStartAtISO('');
                    }}
                    tabIndex={7 + idx}
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

        {/* 希望日付 */}
        <div>
          <label className="block text-sm font-medium text-adm-text mb-1">希望日</label>
          <input
            type="date"
            value={dateISO}
            onChange={(e) => {
              setDateISO(e.target.value);
              setSelectedStartAtISO('');
              setSelectedTherapistId('');
              setSelectedTherapistSlug('');
            }}
            min={new Date().toISOString().slice(0, 10)}
            className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
            tabIndex={8 + options.length}
            required
          />
        </div>

        {/* セラピスト候補セレクタ */}
        {dateISO && courseId && (
          <div>
            <label className="block text-sm font-medium text-adm-text mb-2">
              セラピスト・利用時間の選択
              <span className="text-red-500 ml-1">*</span>
            </label>

            {/* 指名あり / 誰でもいい の切り替え */}
            <div className="flex gap-4 mb-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="therapistMode"
                  checked={therapistSelectMode === 'specific'}
                  onChange={() => {
                    setTherapistSelectMode('specific');
                    setSelectedStartAtISO('');
                  }}
                />
                <span className="text-sm">指名あり</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="therapistMode"
                  checked={therapistSelectMode === 'any'}
                  onChange={() => {
                    setTherapistSelectMode('any');
                    setSelectedTherapistId('');
                    setSelectedTherapistSlug('');
                    setSelectedStartAtISO('');
                  }}
                />
                <span className="text-sm">誰でもいい（候補を検索）</span>
              </label>
            </div>

            {/* 指名ありの場合: セラピスト選択 → 枠表示 */}
            {therapistSelectMode === 'specific' && (
              <div className="space-y-3">
                <select
                  value={selectedTherapistId}
                  onChange={(e) => {
                    handleSpecificTherapistChange(e.target.value);
                  }}
                  className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
                  tabIndex={9 + options.length}
                >
                  <option value="">セラピストを選択</option>
                  {therapists.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>

                {/* 選択セラピストの枠一覧 */}
                {selectedTherapistId && (
                  <div>
                    {candidatesLoading && (
                      <p className="text-xs text-adm-muted">枠を確認中…</p>
                    )}
                    {!candidatesLoading && candidatesError && (
                      <p className="text-xs text-red-600">{candidatesError}</p>
                    )}
                    {!candidatesLoading && (() => {
                      const candidate = candidateTherapists.find((c) => c.id === selectedTherapistId);
                      if (!candidate) return null;
                      return (
                        <div>
                          <p className="text-xs text-adm-muted mb-1">利用可能枠:</p>
                          <div className="flex flex-wrap gap-2">
                            {candidate.slots.map((slot) => (
                              <button
                                key={slot.startAtISO}
                                type="button"
                                onClick={() => handleSlotSelect(candidate, slot)}
                                className={`px-3 py-1 text-sm rounded border transition-colors ${
                                  selectedStartAtISO === slot.startAtISO
                                    ? 'bg-adm-primary text-white border-adm-primary'
                                    : 'bg-adm-surface text-adm-text border-adm-border hover:bg-adm-bg'
                                }`}
                              >
                                {slot.time}
                              </button>
                            ))}
                            {candidate.slots.length === 0 && (
                              <span className="text-xs text-adm-muted">この条件で利用可能な枠がありません</span>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* 誰でもいいの場合: 候補一覧を全員表示 */}
            {therapistSelectMode === 'any' && (
              <div>
                {candidatesLoading && (
                  <p className="text-xs text-adm-muted">候補を検索中…</p>
                )}
                {!candidatesLoading && candidatesError && (
                  <p className="text-xs text-red-600">{candidatesError}</p>
                )}
                {!candidatesLoading && candidateTherapists.length > 0 && (
                  <div className="space-y-3">
                    {candidateTherapists.map((therapist) => (
                      <div key={therapist.id} className="border border-adm-border rounded p-3">
                        <p className="text-sm font-medium text-adm-text mb-2">{therapist.name}</p>
                        <div className="flex flex-wrap gap-2">
                          {therapist.slots.map((slot) => (
                            <button
                              key={slot.startAtISO}
                              type="button"
                              onClick={() => handleSlotSelect(therapist, slot)}
                              className={`px-3 py-1 text-sm rounded border transition-colors ${
                                selectedTherapistId === therapist.id && selectedStartAtISO === slot.startAtISO
                                  ? 'bg-adm-primary text-white border-adm-primary'
                                  : 'bg-adm-surface text-adm-text border-adm-border hover:bg-adm-bg'
                              }`}
                            >
                              {slot.time}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 選択状態の表示 */}
            {selectedTherapistId && selectedStartAtISO && (
              <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded text-sm text-green-800">
                選択: {therapists.find((t) => t.id === selectedTherapistId)?.name ?? candidateTherapists.find((t) => t.id === selectedTherapistId)?.name} ・{' '}
                {new Date(selectedStartAtISO).toLocaleString('ja-JP', {
                  timeZone: 'Asia/Tokyo',
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            )}
          </div>
        )}

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
            disabled={loading || !selectedTherapistId || !selectedStartAtISO}
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
                onClick={() => { void handleLostOrder(); }}
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
