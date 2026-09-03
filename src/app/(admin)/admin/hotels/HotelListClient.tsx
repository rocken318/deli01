"use client";

/**
 * 派遣ホテル台帳のクライアント側コンポーネント（/admin/hotels）。
 * - ホテル一覧テーブル（name/エリア/extra_minutes/entry_note/address/is_blocked）
 * - 新規追加フォーム
 * - 各行インライン編集・受け入れ停止トグル・削除
 * 3状態: 空状態 / ロード中 / エラー
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { HotelAdminRow } from "@/lib/hotels/hotel-admin-actions";
import {
  createHotel,
  updateHotel,
  deleteHotel,
} from "@/lib/hotels/hotel-admin-actions";

interface AreaOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// 新規追加フォーム
// ---------------------------------------------------------------------------

function AddHotelForm({ areas, onDone }: { areas: AreaOption[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [nameKana, setNameKana] = useState("");
  const [address, setAddress] = useState("");
  const [areaId, setAreaId] = useState("");
  const [entryNote, setEntryNote] = useState("");
  const [parkingNote, setParkingNote] = useState("");
  const [extraMinutes, setExtraMinutes] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createHotel({
        name: name.trim(),
        nameKana: nameKana.trim() || undefined,
        address: address.trim() || undefined,
        areaId: areaId || undefined,
        entryNote: entryNote.trim() || undefined,
        parkingNote: parkingNote.trim() || undefined,
        extraMinutes,
        note: note.trim() || undefined,
      });
      if (result.ok) {
        setName("");
        setNameKana("");
        setAddress("");
        setAreaId("");
        setEntryNote("");
        setParkingNote("");
        setExtraMinutes(0);
        setNote("");
        onDone();
      } else {
        setError(result.error ?? "追加に失敗しました");
      }
    });
  };

  const inputCls = "border border-adm-border px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-1 focus:ring-adm-primary bg-adm-surface text-adm-text";
  const r4 = { borderRadius: "4px" } as const;

  return (
    <form onSubmit={handleSubmit} className="border border-adm-border p-4 space-y-3 bg-adm-surface" style={r4}>
      <h2 className="text-sm font-semibold text-adm-text">ホテルを追加</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-1">
          <label className="block text-xs text-adm-text/70 mb-1">ホテル名 <span className="text-adm-danger">*</span></label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} style={r4} placeholder="ホテルニューオータニ仙台" />
        </div>
        <div>
          <label className="block text-xs text-adm-text/70 mb-1">ふりがな</label>
          <input value={nameKana} onChange={(e) => setNameKana(e.target.value)} className={inputCls} style={r4} placeholder="ほてるにゅーおーたに" />
        </div>
        <div>
          <label className="block text-xs text-adm-text/70 mb-1">エリア</label>
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)} className={inputCls} style={r4}>
            <option value="">— 未設定 —</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-adm-text/70 mb-1">住所</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputCls} style={r4} placeholder="宮城県仙台市青葉区…" />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-adm-text/70 mb-1">入り方（フロント経由・直接部屋へ等）</label>
          <input value={entryNote} onChange={(e) => setEntryNote(e.target.value)} className={inputCls} style={r4} placeholder="フロントで呼び出し後、部屋へ直接" />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-adm-text/70 mb-1">駐車場</label>
          <input value={parkingNote} onChange={(e) => setParkingNote(e.target.value)} className={inputCls} style={r4} placeholder="地下P有・30分無料" />
        </div>
        <div>
          <label className="block text-xs text-adm-text/70 mb-1">追加移動分（分）</label>
          <input
            type="number" min={0} value={extraMinutes}
            onChange={(e) => setExtraMinutes(Math.max(0, parseInt(e.target.value, 10) || 0))}
            className={inputCls} style={r4}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-adm-text/70 mb-1">メモ</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} style={r4} placeholder="内部メモ" />
        </div>
      </div>
      {error && <p className="text-xs text-adm-danger">{error}</p>}
      <button
        type="submit" disabled={isPending || !name.trim()}
        className="px-4 py-2 text-sm bg-adm-primary text-white disabled:opacity-50"
        style={r4}
      >
        {isPending ? "追加中…" : "追加する"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 行コンポーネント
// ---------------------------------------------------------------------------

function HotelRow({ hotel, areas, onDone }: { hotel: HotelAdminRow; areas: AreaOption[]; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({
    name: hotel.name,
    nameKana: hotel.nameKana ?? "",
    address: hotel.address ?? "",
    areaId: hotel.areaId ?? "",
    entryNote: hotel.entryNote ?? "",
    parkingNote: hotel.parkingNote ?? "",
    extraMinutes: hotel.extraMinutes,
    note: hotel.note ?? "",
  });
  const [rowError, setRowError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const r4 = { borderRadius: "4px" } as const;
  const inputCls = "border border-adm-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary bg-adm-surface text-adm-text w-full";

  const handleSave = () => {
    setRowError(null);
    startTransition(async () => {
      const result = await updateHotel({
        id: hotel.id,
        name: editData.name.trim(),
        nameKana: editData.nameKana.trim() || null,
        address: editData.address.trim() || null,
        areaId: editData.areaId || null,
        entryNote: editData.entryNote.trim() || null,
        parkingNote: editData.parkingNote.trim() || null,
        extraMinutes: editData.extraMinutes,
        note: editData.note.trim() || null,
      });
      if (result.ok) {
        setEditing(false);
        onDone();
      } else {
        setRowError(result.error ?? "更新に失敗しました");
      }
    });
  };

  const handleToggleBlocked = () => {
    startTransition(async () => {
      const result = await updateHotel({ id: hotel.id, isBlocked: !hotel.isBlocked });
      if (result.ok) {
        onDone();
      } else {
        setRowError(result.error ?? "更新に失敗しました");
      }
    });
  };

  const handleDelete = () => {
    if (!confirm(`「${hotel.name}」を削除しますか？予約から参照中の場合は削除できません。`)) return;
    startTransition(async () => {
      const result = await deleteHotel(hotel.id);
      if (result.ok) {
        onDone();
      } else {
        setRowError(result.error ?? "削除に失敗しました");
      }
    });
  };

  if (editing) {
    return (
      <tr className="border-b border-adm-border align-top">
        <td colSpan={7} className="px-3 py-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-xs text-adm-text/70">ホテル名</label>
              <input value={editData.name} onChange={(e) => setEditData((d) => ({ ...d, name: e.target.value }))} className={inputCls} style={r4} />
            </div>
            <div>
              <label className="text-xs text-adm-text/70">ふりがな</label>
              <input value={editData.nameKana} onChange={(e) => setEditData((d) => ({ ...d, nameKana: e.target.value }))} className={inputCls} style={r4} />
            </div>
            <div>
              <label className="text-xs text-adm-text/70">エリア</label>
              <select value={editData.areaId} onChange={(e) => setEditData((d) => ({ ...d, areaId: e.target.value }))} className={inputCls} style={r4}>
                <option value="">— 未設定 —</option>
                {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="col-span-3">
              <label className="text-xs text-adm-text/70">住所</label>
              <input value={editData.address} onChange={(e) => setEditData((d) => ({ ...d, address: e.target.value }))} className={inputCls} style={r4} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-adm-text/70">入り方</label>
              <input value={editData.entryNote} onChange={(e) => setEditData((d) => ({ ...d, entryNote: e.target.value }))} className={inputCls} style={r4} />
            </div>
            <div>
              <label className="text-xs text-adm-text/70">追加移動分</label>
              <input type="number" min={0} value={editData.extraMinutes} onChange={(e) => setEditData((d) => ({ ...d, extraMinutes: Math.max(0, parseInt(e.target.value, 10) || 0) }))} className={inputCls} style={r4} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-adm-text/70">駐車場</label>
              <input value={editData.parkingNote} onChange={(e) => setEditData((d) => ({ ...d, parkingNote: e.target.value }))} className={inputCls} style={r4} />
            </div>
            <div>
              <label className="text-xs text-adm-text/70">メモ</label>
              <input value={editData.note} onChange={(e) => setEditData((d) => ({ ...d, note: e.target.value }))} className={inputCls} style={r4} />
            </div>
          </div>
          {rowError && <p className="text-xs text-adm-danger mt-1">{rowError}</p>}
          <div className="flex gap-2 mt-2">
            <button onClick={handleSave} disabled={isPending} className="px-3 py-1 text-xs bg-adm-primary text-white disabled:opacity-50" style={r4}>
              {isPending ? "保存中…" : "保存"}
            </button>
            <button onClick={() => { setEditing(false); setRowError(null); }} className="px-3 py-1 text-xs border border-adm-border text-adm-text" style={r4}>
              キャンセル
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className={`border-b border-adm-border text-sm ${hotel.isBlocked ? "opacity-50" : ""}`}>
      <td className="px-3 py-2">
        <span className="font-medium text-adm-text">{hotel.name}</span>
        {hotel.nameKana && <span className="block text-xs text-adm-text/60">{hotel.nameKana}</span>}
        {rowError && <p className="text-xs text-adm-danger mt-0.5">{rowError}</p>}
      </td>
      <td className="px-3 py-2 text-adm-text/70">{hotel.areaName ?? "—"}</td>
      <td className="px-3 py-2 text-adm-text/70 whitespace-nowrap">{hotel.extraMinutes}分</td>
      <td className="px-3 py-2 text-adm-text/70 max-w-[200px] truncate">{hotel.entryNote ?? "—"}</td>
      <td className="px-3 py-2 text-adm-text/70 max-w-[180px] truncate">{hotel.address ?? "—"}</td>
      <td className="px-3 py-2 text-center">
        {hotel.isBlocked
          ? <span className="px-2 py-0.5 text-xs bg-adm-danger/10 text-adm-danger" style={r4}>停止中</span>
          : <span className="px-2 py-0.5 text-xs bg-adm-primary/10 text-adm-primary" style={r4}>受入中</span>
        }
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-2 justify-end flex-wrap">
          <button onClick={() => setEditing(true)} disabled={isPending} className="text-xs text-adm-primary underline disabled:opacity-50">編集</button>
          <button onClick={handleToggleBlocked} disabled={isPending} className="text-xs text-adm-caution underline disabled:opacity-50">
            {hotel.isBlocked ? "再開" : "停止"}
          </button>
          <button onClick={handleDelete} disabled={isPending} className="text-xs text-adm-danger underline disabled:opacity-50">削除</button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

export function HotelListClient({ hotels, areas }: { hotels: HotelAdminRow[]; areas: AreaOption[] }) {
  const router = useRouter();
  const refresh = () => router.refresh();

  return (
    <div className="space-y-6">
      {/* 追加フォーム */}
      <AddHotelForm areas={areas} onDone={refresh} />

      {/* 一覧 */}
      <div className="bg-adm-surface border border-adm-border overflow-x-auto" style={{ borderRadius: "4px" }}>
        {hotels.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-adm-text/50">
            ホテルが登録されていません。上のフォームから追加してください。
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-adm-border bg-adm-bg">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-adm-text/70">ホテル名</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-adm-text/70">エリア</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-adm-text/70">追加移動</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-adm-text/70">入り方</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-adm-text/70">住所</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-adm-text/70">状態</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-adm-text/70">操作</th>
              </tr>
            </thead>
            <tbody>
              {hotels.map((h) => (
                <HotelRow key={h.id} hotel={h} areas={areas} onDone={refresh} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}