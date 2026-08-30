import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { resolveAppUserSession } from "@/lib/auth/resolve-session";

/**
 * 本番 Auth 写像の検証（実 Postgres / spec フェーズ1）。
 * resolveAppUserSession は auth.getUser() で得た auth_user_id を
 * app_users の Session に写す純DB関数。cookie/getUser 側は対象外。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const authActive = randomUUID();
const authInactive = randomUUID();
const authTherapist = randomUUID();
const authUnlinked = randomUUID();
let therapistId = "";

beforeAll(async () => {
  const t = await sql<{ id: string }[]>`select id from therapists limit 1`;
  therapistId = t[0]!.id;
  await sql`
    insert into app_users (auth_user_id, role, display_name, is_active)
    values
      (${authActive}, 'admin', 'live-test-admin', true),
      (${authInactive}, 'admin', 'live-test-inactive', false)
  `;
  await sql`
    insert into app_users (auth_user_id, role, therapist_id, display_name, is_active)
    values (${authTherapist}, 'therapist', ${therapistId}, 'live-test-th', true)
  `;
});

afterAll(async () => {
  await sql`delete from app_users where display_name like 'live-test-%'`;
  await sql.end();
});

describe("resolveAppUserSession", () => {
  it("有効な auth_user_id を role 付き Session に写す", async () => {
    const s = await resolveAppUserSession(sql, authActive);
    expect(s).not.toBeNull();
    expect(s!.role).toBe("admin");
    expect(s!.therapistId).toBeUndefined();
  });
  it("therapist は therapistId を持つ", async () => {
    const s = await resolveAppUserSession(sql, authTherapist);
    expect(s!.role).toBe("therapist");
    expect(s!.therapistId).toBe(therapistId);
  });
  it("is_active=false は null", async () => {
    expect(await resolveAppUserSession(sql, authInactive)).toBeNull();
  });
  it("未紐付けの auth ユーザーは null", async () => {
    expect(await resolveAppUserSession(sql, authUnlinked)).toBeNull();
  });
});
