import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
import { listBackPriceTargets } from "@/lib/payout/back-prices-actions";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let courseId: string;
let optionId: string;
let rateIdCourse: string;
let rateIdOption: string;
let rateIdNomination: string;

const EFF_FROM = "2024-01-01"; // 過去日: current_date より前（固定レートのテスト用）

beforeAll(async () => {
  // 既存の is_active コースとオプションを取得
  const courses = await sql<{ id: string }[]>`
    select id from courses where is_active = true order by created_at limit 1
  `;
  courseId = courses[0]!.id;

  const options = await sql<{ id: string }[]>`
    select id from options where is_active = true order by created_at limit 1
  `;
  optionId = options[0]!.id;

  // 既存の未来日レートがあれば削除（テスト用）
  await sql`
    delete from payout_rates
    where effective_from = ${EFF_FROM}::date
      and therapist_id is null and rank_id is null
      and target_type in ('course','option','nomination')
  `;

  // コース用レート挿入
  const cr = await sql<{ id: string }[]>`
    insert into payout_rates (therapist_id, rank_id, target_type, target_id, calc_type, value, effective_from, effective_to, note)
    values (null, null, 'course', ${courseId}::uuid, 'fixed', 7777, ${EFF_FROM}::date, null, 'test-course-rate')
    returning id
  `;
  rateIdCourse = cr[0]!.id;

  // オプション用レート挿入
  const or_ = await sql<{ id: string }[]>`
    insert into payout_rates (therapist_id, rank_id, target_type, target_id, calc_type, value, effective_from, effective_to, note)
    values (null, null, 'option', ${optionId}::uuid, 'fixed', 2222, ${EFF_FROM}::date, null, 'test-option-rate')
    returning id
  `;
  rateIdOption = or_[0]!.id;

  // 指名用レート挿入 (target_id IS NULL)
  const nr = await sql<{ id: string }[]>`
    insert into payout_rates (therapist_id, rank_id, target_type, target_id, calc_type, value, effective_from, effective_to, note)
    values (null, null, 'nomination', null, 'fixed', 3333, ${EFF_FROM}::date, null, 'test-nomination-rate')
    returning id
  `;
  rateIdNomination = nr[0]!.id;
});

afterAll(async () => {
  await sql`delete from payout_rates where id = ${rateIdCourse}::uuid or id = ${rateIdOption}::uuid or id = ${rateIdNomination}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("listBackPriceTargets", () => {
  it("コースのバック単価を返す", async () => {
    const r = await listBackPriceTargets();
    expect(r.ok).toBe(true);
    const course = r.data?.courses.find((c) => c.id === courseId);
    expect(course).toBeDefined();
    expect(course?.backYen).toBe(7777);
  });

  it("オプションのバック単価を返す", async () => {
    const r = await listBackPriceTargets();
    expect(r.ok).toBe(true);
    const option = r.data?.options.find((o) => o.id === optionId);
    expect(option).toBeDefined();
    expect(option?.backYen).toBe(2222);
  });

  it("指名バック単価を返す", async () => {
    const r = await listBackPriceTargets();
    expect(r.ok).toBe(true);
    expect(r.data?.nominationBackYen).toBe(3333);
  });
});
