'use server';

/**
 * 通知系の Server Actions（フェーズ20）。
 * - enqueueDueReminders の手動トリガ
 * - generateWeeklyReport の手動トリガ（先週分）
 * - applyFlashDealBatch: 本日 confirmed 予約に直前割を一括適用
 * - listNotifications: outbox 一覧
 * - getNotificationTemplate / saveNotificationTemplate: テンプレ編集
 * - loadFlashDealConfigAction / saveFlashDealConfigAction: 直前割 CMS 設定
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { enqueueDueReminders } from './reminders';
import { generateWeeklyReport, type GenerateWeeklyReportResult } from './weekly';
import { applyFlashDeal } from '@/lib/flashdeal/actions';
import { loadFlashDealConfig } from '@/lib/flashdeal/config';
import { saveSiteSetting } from '@/lib/cms/site-settings-actions';
import { format, subDays, startOfWeek } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { EnqueueDueRemindersResult } from './reminders';
import type { FlashDealConfig } from '@/domain/flashdeal';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// outbox 一覧
// ---------------------------------------------------------------------------

export interface NotificationRow {
  id: string;
  kind: string;
  channel: string;
  recipient: string;
  subject: string;
  status: string;
  scheduledFor: string | null;
  sentAt: string | null;
  createdAt: string;
}

export async function listNotifications(params: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<ActionResult<{ rows: NotificationRow[]; total: number }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) return { ok: false, error: '権限がありません' };

  const sql = getClient();
  try {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;

    const whereClause = params.status
      ? sql`where status = ${params.status}::notification_status`
      : sql``;

    const countRows = await sql<{ total: number }[]>`
      select count(*)::integer as total from notifications ${whereClause}
    `;
    const total = countRows[0]?.total ?? 0;

    const rows = await sql<{
      id: string;
      kind: string;
      channel: string;
      recipient: string;
      subject: string;
      status: string;
      scheduled_for: Date | null;
      sent_at: Date | null;
      created_at: Date;
    }[]>`
      select
        id::text as id,
        kind::text as kind,
        channel::text as channel,
        recipient,
        subject,
        status::text as status,
        scheduled_for,
        sent_at,
        created_at
      from notifications
      ${whereClause}
      order by id desc
      limit ${limit} offset ${offset}
    `;

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          channel: r.channel,
          recipient: r.recipient,
          subject: r.subject,
          status: r.status,
          scheduledFor: r.scheduled_for?.toISOString() ?? null,
          sentAt: r.sent_at?.toISOString() ?? null,
          createdAt: r.created_at.toISOString(),
        })),
        total,
      },
    };
  } catch (e) {
    console.error('listNotifications failed:', e);
    return { ok: false, error: '通知一覧の取得に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 手動トリガ: リマインド
// ---------------------------------------------------------------------------

export async function triggerEnqueueReminders(): Promise<
  ActionResult<EnqueueDueRemindersResult>
> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) return { ok: false, error: '権限がありません' };

  const sql = getClient();
  try {
    const result = await enqueueDueReminders(sql, session, new Date());
    return { ok: true, data: result };
  } catch (e) {
    console.error('triggerEnqueueReminders failed:', e);
    return { ok: false, error: 'リマインド生成に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 手動トリガ: 週次レポート（先週分）
// ---------------------------------------------------------------------------

export async function triggerWeeklyReport(): Promise<
  ActionResult<GenerateWeeklyReportResult>
> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) return { ok: false, error: '権限がありません' };

  const sql = getClient();
  try {
    // 先週の月曜 JST を計算
    const nowJST = toZonedTime(new Date(), 'Asia/Tokyo');
    const thisMonday = startOfWeek(nowJST, { weekStartsOn: 1 });
    const lastMonday = subDays(thisMonday, 7);
    const weekStartISO = format(lastMonday, 'yyyy-MM-dd');

    const result = await generateWeeklyReport(sql, session, {
      weekStartISO,
      now: new Date(),
    });
    return { ok: true, data: result };
  } catch (e) {
    console.error('triggerWeeklyReport failed:', e);
    return { ok: false, error: '週次レポート生成に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 手動トリガ: 本日直前割バッチ
// ---------------------------------------------------------------------------

export interface FlashDealBatchResult {
  applied: number;
  skipped: number;
  failed: number;
}

export async function triggerFlashDealBatch(): Promise<ActionResult<FlashDealBatchResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) return { ok: false, error: '権限がありません' };

  const sql = getClient();
  try {
    // 本日 JST の confirmed 予約を取得
    const nowJST = toZonedTime(new Date(), 'Asia/Tokyo');
    const todayISO = format(nowJST, 'yyyy-MM-dd');
    const todayStart = new Date(`${todayISO}T00:00:00+09:00`);
    const todayEnd = new Date(`${todayISO}T23:59:59+09:00`);

    const targets = await sql<{ id: string }[]>`
      select id::text as id from reservations
      where status = 'confirmed'
        and start_at >= ${todayStart}::timestamptz
        and start_at <= ${todayEnd}::timestamptz
        and is_flash_deal = false
    `;

    let applied = 0;
    let skipped = 0;
    let failed = 0;

    for (const t of targets) {
      const result = await applyFlashDeal(t.id);
      if (result.ok) {
        applied += 1;
      } else if (
        result.error?.includes('適用済み') ||
        result.error?.includes('無効') ||
        result.error?.includes('対象')
      ) {
        skipped += 1;
      } else {
        failed += 1;
      }
    }

    return { ok: true, data: { applied, skipped, failed } };
  } catch (e) {
    console.error('triggerFlashDealBatch failed:', e);
    return { ok: false, error: '直前割バッチに失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 通知テンプレ編集
// ---------------------------------------------------------------------------

export interface NotificationTemplate {
  kind: string;
  name: string;
  subject: string;
  body: string;
  isActive: boolean;
}

export async function getNotificationTemplates(): Promise<
  ActionResult<NotificationTemplate[]>
> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const sql = getClient();
  try {
    const rows = await sql<{
      kind: string;
      name: string;
      subject: string;
      body: string;
      is_active: boolean;
    }[]>`
      select kind::text as kind, name, subject, body, is_active
      from notification_templates
      where kind in (
        'reminder_prev_day', 'reminder_2h', 'waitlist_open', 'weekly_report'
      )
      order by kind
    `;
    return {
      ok: true,
      data: rows.map((r) => ({
        kind: r.kind,
        name: r.name,
        subject: r.subject,
        body: r.body,
        isActive: r.is_active,
      })),
    };
  } catch (e) {
    console.error('getNotificationTemplates failed:', e);
    return { ok: false, error: 'テンプレートの取得に失敗しました' };
  }
}

const saveTemplateSchema = z.object({
  kind: z.enum(['reminder_prev_day', 'reminder_2h', 'waitlist_open', 'weekly_report']),
  subject: z.string().min(1, '件名は必須です').max(200),
  body: z.string().min(1, '本文は必須です').max(5000),
  name: z.string().min(1, 'テンプレート名は必須です').max(100),
});

export async function saveNotificationTemplate(
  kind: string,
  subject: string,
  body: string,
  name: string,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) return { ok: false, error: '権限がありません' };

  const parsed = saveTemplateSchema.safeParse({ kind, subject, body, name });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }
  const d = parsed.data;

  const sql = getClient();
  try {
    await sql`
      update notification_templates
      set subject = ${d.subject}, body = ${d.body}, name = ${d.name},
          updated_at = now(), updated_by = ${session.userId}::uuid
      where kind = ${d.kind}::notification_kind
    `;
    return { ok: true };
  } catch (e) {
    console.error('saveNotificationTemplate failed:', e);
    return { ok: false, error: 'テンプレートの保存に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 直前割 CMS 設定
// ---------------------------------------------------------------------------

export async function getFlashDealConfigAction(): Promise<ActionResult<FlashDealConfig>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const sql = getClient();
  try {
    const config = await loadFlashDealConfig(sql);
    return { ok: true, data: config };
  } catch (e) {
    console.error('getFlashDealConfigAction failed:', e);
    return { ok: false, error: '直前割設定の取得に失敗しました' };
  }
}

const flashConfigSchema = z.object({
  enabled: z.boolean(),
  ratePercent: z.number().int().min(1).max(100),
  windowFromHour: z.number().int().min(0).max(23),
  windowToHour: z.number().int().min(1).max(24),
  dailyLimit: z.number().int().min(1).max(100),
  triggerHour: z.number().int().min(0).max(23),
});

export async function saveFlashDealConfigAction(
  config: Partial<FlashDealConfig>,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) return { ok: false, error: '権限がありません' };

  const parsed = flashConfigSchema.safeParse({
    enabled: config.enabled ?? false,
    ratePercent: config.ratePercent ?? 10,
    windowFromHour: config.windowFromHour ?? 18,
    windowToHour: config.windowToHour ?? 24,
    dailyLimit: config.dailyLimit ?? 3,
    triggerHour: config.triggerHour ?? 15,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }

  const d = parsed.data;
  const jsonValue = {
    enabled: d.enabled,
    rate_percent: d.ratePercent,
    window_from_hour: d.windowFromHour,
    window_to_hour: d.windowToHour,
    daily_limit: d.dailyLimit,
    course_ids: config.courseIds ?? [],
    trigger_hour: d.triggerHour,
  };

  return saveSiteSetting('flash_deal_config', jsonValue);
}
