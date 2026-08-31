"use client";

/**
 * 派遣エリア台帳のクライアント側コンポーネント（/admin/areas）。
 * - 有効/無効トグル
 * - インライン改名
 * - エリア追加フォーム（座標は折りたたみ）
 */

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, useTransition } from "react";
import type { DispatchArea } from "@/lib/cms/area-actions";
import {
  createDispatchArea,
  renameDispatchArea,
  setDispatchAreaActive,
} from "@/lib/cms/area-actions";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<DispatchArea["kind"], string> = {
  ward: "区",
  city: "市",
  station: "駅",
};

// ---------------------------------------------------------------------------
// 個別行
// ---------------------------------------------------------------------------

function AreaRow({ area }: { area: DispatchArea }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // 改名モード
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(area.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleToggleActive = useCallback(() => {
    startTransition(async () => {
      const result = await setDispatchAreaActive(area.id, !area.isActive);
      if (result.ok) {
        router.refresh();
      } else {
        alert(result.error ?? "切り替えに失敗しました");
      }
    });
  }, [area.id, area.isActive, router]);

  const handleRenameSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setRenameError(null);
      const trimmed = editName.trim();
      if (!trimmed) {
        setRenameError("エリア名を入力してください");
        return;
      }
      if (trimmed === area.name) {
        setEditing(false);
        return;
      }
      startTransition(async () => {
        const result = await renameDispatchArea(area.id, trimmed);
        if (result.ok) {
          setEditing(false);
          router.refresh();
        } else {
          setRenameError(result.error ?? "改名に失敗しました");
        }
      });
    },
    [area.id, area.name, editName, router],
  );

  const handleEditStart = useCallback(() => {
    setEditName(area.name);
    setRenameError(null);
    setEditing(true);
    // フォーカスは次レンダ後
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [area.name]);

  const handleEditCancel = useCallback(() => {
    setEditing(false);
    setEditName(area.name);
    setRenameError(null);
  }, [area.name]);

  return (
    <tr className={area.isActive ? "" : "opacity-50"}>
      {/* エリア名 */}
      <td className="py-2.5 pr-4 text-sm text-adm-text align-middle">
        {editing ? (
          <form onSubmit={handleRenameSubmit} className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              disabled={isPending}
              className="border border-adm-border bg-white px-2 py-1 text-sm text-adm-text w-40"
              style={{ borderRadius: "4px" }}
              aria-label="エリア名"
            />
            <button
              type="submit"
              disabled={isPending}
              className="px-2 py-1 bg-adm-primary text-white text-xs font-medium hover:opacity-90 disabled:opacity-50"
              style={{ borderRadius: "4px" }}
            >
              保存
            </button>
            <button
              type="button"
              onClick={handleEditCancel}
              disabled={isPending}
              className="px-2 py-1 border border-adm-border text-xs text-adm-text hover:border-adm-primary disabled:opacity-50"
              style={{ borderRadius: "4px" }}
            >
              取消
            </button>
            {renameError && (
              <span className="text-xs text-adm-danger">{renameError}</span>
            )}
          </form>
        ) : (
          <div className="flex items-center gap-2">
            <span>{area.name}</span>
            <button
              type="button"
              onClick={handleEditStart}
              className="text-xs text-adm-text/50 hover:text-adm-primary border border-transparent hover:border-adm-border px-1.5 py-0.5"
              style={{ borderRadius: "4px" }}
              title="改名"
            >
              改名
            </button>
          </div>
        )}
      </td>

      {/* 種別 */}
      <td className="py-2.5 pr-4 text-sm text-adm-text/70 align-middle tabular-nums">
        {KIND_LABELS[area.kind]}
      </td>

      {/* 座標 */}
      <td className="py-2.5 pr-4 text-xs text-adm-text/50 align-middle tabular-nums whitespace-nowrap">
        {area.lon !== null && area.lat !== null
          ? `${area.lat.toFixed(4)}, ${area.lon.toFixed(4)}`
          : "—"}
      </td>

      {/* 状態トグル */}
      <td className="py-2.5 align-middle">
        <button
          type="button"
          onClick={handleToggleActive}
          disabled={isPending}
          className={`px-3 py-1 text-xs font-medium border transition-colors disabled:opacity-50 ${
            area.isActive
              ? "bg-adm-primary text-white border-adm-primary hover:opacity-90"
              : "bg-white text-adm-text/60 border-adm-border hover:border-adm-primary hover:text-adm-primary"
          }`}
          style={{ borderRadius: "4px" }}
          aria-label={area.isActive ? `${area.name} を無効化` : `${area.name} を有効化`}
        >
          {area.isActive ? "有効" : "無効"}
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// 追加フォーム
// ---------------------------------------------------------------------------

function AddAreaForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DispatchArea["kind"]>("ward");
  const [showCoords, setShowCoords] = useState(false);
  const [lon, setLon] = useState("");
  const [lat, setLat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setSuccess(null);

      const trimmedName = name.trim();
      if (!trimmedName) {
        setError("エリア名を入力してください");
        return;
      }

      const lonVal = lon.trim() ? parseFloat(lon.trim()) : undefined;
      const latVal = lat.trim() ? parseFloat(lat.trim()) : undefined;

      if (lon.trim() && (isNaN(lonVal ?? NaN) || lonVal === undefined || lonVal < -180 || lonVal > 180)) {
        setError("経度は -180〜180 の数値を入力してください");
        return;
      }
      if (lat.trim() && (isNaN(latVal ?? NaN) || latVal === undefined || latVal < -90 || latVal > 90)) {
        setError("緯度は -90〜90 の数値を入力してください");
        return;
      }

      startTransition(async () => {
        const result = await createDispatchArea({
          name: trimmedName,
          kind,
          lon: lonVal,
          lat: latVal,
        });

        if (result.ok) {
          setName("");
          setLon("");
          setLat("");
          setSuccess(`「${trimmedName}」を追加しました`);
          router.refresh();
        } else {
          setError(result.error ?? "追加に失敗しました");
        }
      });
    },
    [name, kind, lon, lat, router],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-adm-border bg-adm-surface p-4 space-y-4"
      style={{ borderRadius: "4px" }}
    >
      <h2 className="text-sm font-semibold text-adm-text">エリアを追加</h2>

      <div className="flex flex-wrap items-end gap-3">
        {/* エリア名 */}
        <label className="block text-xs text-adm-text/70">
          エリア名
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: 青葉区、仙台市、仙台駅"
            disabled={isPending}
            className="mt-1 block border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text w-52"
            style={{ borderRadius: "4px" }}
            required
          />
        </label>

        {/* 種別 */}
        <label className="block text-xs text-adm-text/70">
          種別
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as DispatchArea["kind"])}
            disabled={isPending}
            className="mt-1 block border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text"
            style={{ borderRadius: "4px" }}
          >
            <option value="ward">区</option>
            <option value="city">市</option>
            <option value="station">駅</option>
          </select>
        </label>

        {/* 追加ボタン */}
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 bg-adm-primary text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
          style={{ borderRadius: "4px" }}
        >
          {isPending ? "追加中..." : "追加"}
        </button>
      </div>

      {/* 座標（折りたたみ） */}
      <div>
        <button
          type="button"
          onClick={() => setShowCoords((v) => !v)}
          className="text-xs text-adm-text/50 hover:text-adm-primary"
        >
          {showCoords ? "座標を隠す" : "座標を指定する（省略時は仙台中心）"}
        </button>
        {showCoords && (
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="block text-xs text-adm-text/70">
              経度（lon）
              <input
                type="number"
                step="any"
                value={lon}
                onChange={(e) => setLon(e.target.value)}
                placeholder="140.8721"
                disabled={isPending}
                className="mt-1 block border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text w-32 tabular-nums"
                style={{ borderRadius: "4px" }}
              />
            </label>
            <label className="block text-xs text-adm-text/70">
              緯度（lat）
              <input
                type="number"
                step="any"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                placeholder="38.2688"
                disabled={isPending}
                className="mt-1 block border border-adm-border bg-white px-2 py-1.5 text-sm text-adm-text w-32 tabular-nums"
                style={{ borderRadius: "4px" }}
              />
            </label>
          </div>
        )}
      </div>

      {/* フィードバック */}
      {error && (
        <p role="alert" className="text-sm text-adm-danger">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="text-sm text-adm-primary">
          {success}
        </p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// メインクライアントコンポーネント
// ---------------------------------------------------------------------------

export function AreaListClient({ areas }: { areas: DispatchArea[] }) {
  return (
    <div className="space-y-6">
      {/* 注記 */}
      <div
        className="border border-adm-border bg-adm-surface p-4 text-sm text-adm-text/70"
        style={{ borderRadius: "4px" }}
      >
        ここで追加した有効エリアは、出勤設定の「対応エリア」チェックに自動で出ます。エリア間の移動時間は未設定間は暫定推定になります（後から調整可）。
      </div>

      {/* 追加フォーム */}
      <AddAreaForm />

      {/* 一覧 */}
      {areas.length === 0 ? (
        <div className="py-16 text-center text-sm text-adm-text/60">
          <p>エリアがまだ登録されていません。</p>
          <p className="mt-1">上のフォームから追加してください。</p>
        </div>
      ) : (
        <div
          className="border border-adm-border bg-adm-surface overflow-x-auto"
          style={{ borderRadius: "4px" }}
        >
          <table className="w-full min-w-[480px]">
            <thead>
              <tr className="border-b border-adm-border">
                <th className="py-2.5 px-4 text-left text-xs font-semibold text-adm-text/70">
                  エリア名
                </th>
                <th className="py-2.5 pr-4 text-left text-xs font-semibold text-adm-text/70">
                  種別
                </th>
                <th className="py-2.5 pr-4 text-left text-xs font-semibold text-adm-text/70">
                  中心座標（緯度, 経度）
                </th>
                <th className="py-2.5 pr-4 text-left text-xs font-semibold text-adm-text/70">
                  状態
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-adm-border">
              {areas.map((area) => (
                <AreaRow key={area.id} area={area} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
