/**
 * メディアストレージ抽象化（spec 3-7）。
 *
 * TODO(Supabase Storage 配線フェーズ): SupabaseMediaStorage の TODO 箇所を実装する。
 *   env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要。
 */

import { env } from "@/lib/env";

export interface UploadResult {
  storagePath: string;
  url: string;
}

export interface MediaStorage {
  upload(path: string, buffer: Buffer, mime: string): Promise<UploadResult>;
  delete(path: string): Promise<void>;
}

const localStorageStub: MediaStorage = {
  async upload(path: string, _buffer: Buffer, _mime: string): Promise<UploadResult> {
    return { storagePath: path, url: "" };
  },
  async delete(_path: string): Promise<void> {
    // no-op
  },
};

class SupabaseMediaStorage implements MediaStorage {
  async upload(path: string, buffer: Buffer, mime: string): Promise<UploadResult> {
    const supabaseUrl = env.supabaseUrl;
    const serviceRoleKey = env.supabaseServiceRoleKey;

    if (!supabaseUrl || !serviceRoleKey) {
      // TODO(Supabase Storage 配線フェーズ): env を必須にしてエラーにする。
      console.warn("[MediaStorage] Supabase env not set — falling back to local stub");
      return localStorageStub.upload(path, buffer, mime);
    }

    // TODO(Supabase Storage 配線フェーズ): @supabase/storage-js を使って実装する。
    // import { StorageClient } from '@supabase/storage-js';
    // const storage = new StorageClient(`${supabaseUrl}/storage/v1`, { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` });
    // const { error } = await storage.from('media').upload(path, buffer, { contentType: mime });
    // if (error) throw error;
    // const { data: { publicUrl } } = storage.from('media').getPublicUrl(path);
    // return { storagePath: path, url: publicUrl };
    throw new Error("Supabase Storage 未実装。TODO を参照してください。");
  }

  async delete(path: string): Promise<void> {
    if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return;
    // TODO(Supabase Storage 配線フェーズ): 削除を実装する。
    void path;
    throw new Error("Supabase Storage 削除: 未実装。");
  }
}

export const mediaStorage: MediaStorage = new SupabaseMediaStorage();
