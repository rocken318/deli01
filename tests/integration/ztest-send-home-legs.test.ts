import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  addSendHomeLeg,
  assignSendHomeDriver,
  getSendHomeLegs,
  finishSendHomeLeg,
  deleteSendHomeLeg,
} from "@/lib/dispatch-board/leg-actions";
import { setLegState } from "@/lib/dispatch-board/leg-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let aoiId: string;
let driverId: string;
const testDate = "2026-09-11";

beforeAll(async () => {
  aoiId = (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id;
  driverId = (await sql<{ id: string }[]>`
    insert into drivers (name, vehicle_color_hex, vehicle_color_name, vehicle_number)
    values ('送りテスト運転手', '#AABBCC', '青', 'T001') returning id`)[0]!.id;
});

afterAll(async () => {
  // cleanup all send_home legs for test date
  await sql`delete from dispatch_legs where work_date = ${testDate}::date and kind = 'send_home'`;
  await sql`delete from drivers where id = ${driverId}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("addSendHomeLeg / getSendHomeLegs", () => {
  let legId: string;

  it("退勤送り脚を追加できる", async () => {
    const r = await addSendHomeLeg({
      therapistId: aoiId,
      dateISO: testDate,
      destinationText: "○○市△△2-3-4",
      roundTripMin: 35,
      memo: "深夜送り",
    });
    expect(r.ok).toBe(true);
    expect(r.data?.legId).toBeDefined();
    legId = r.data!.legId;
  });

  it("getSendHomeLegs で取得できる（therapistName・送り先・往復分）", async () => {
    const r = await getSendHomeLegs(testDate);
    expect(r.ok).toBe(true);
    const leg = r.data?.find((l) => l.id === legId);
    expect(leg).toBeDefined();
    expect(leg?.destinationText).toBe("○○市△△2-3-4");
    expect(leg?.roundTripMin).toBe(35);
    expect(typeof leg?.therapistName).toBe("string");
    expect(leg?.isFinished).toBe(false);
  });

  it("assignSendHomeDriver でドライバーを割当できる", async () => {
    const r = await assignSendHomeDriver({ legId, driverId });
    expect(r.ok).toBe(true);
    const legs = await getSendHomeLegs(testDate);
    const leg = legs.data?.find((l) => l.id === legId);
    expect(leg?.driverId).toBe(driverId);
    expect(leg?.vehicleColorHex).toBe("#AABBCC");
  });

  it("setLegState('完了') → finishSendHomeLeg で is_finished=true", async () => {
    await setLegState({ legId, slot: "send", state: "完了" });
    const fin = await finishSendHomeLeg({ legId });
    expect(fin.ok).toBe(true);
  });

  it("includeFinished=false では完了済みが非表示", async () => {
    const r = await getSendHomeLegs(testDate, false);
    expect(r.ok).toBe(true);
    expect(r.data?.find((l) => l.id === legId)).toBeUndefined();
  });

  it("includeFinished=true では完了済みが表示", async () => {
    const r = await getSendHomeLegs(testDate, true);
    expect(r.ok).toBe(true);
    const leg = r.data?.find((l) => l.id === legId);
    expect(leg?.isFinished).toBe(true);
  });

  it("deleteSendHomeLeg で削除できる", async () => {
    // Create a new leg to delete
    const r2 = await addSendHomeLeg({
      therapistId: aoiId,
      dateISO: testDate,
      destinationText: "削除テスト",
      roundTripMin: null,
    });
    expect(r2.ok).toBe(true);
    const del = await deleteSendHomeLeg({ legId: r2.data!.legId });
    expect(del.ok).toBe(true);
    const legs = await getSendHomeLegs(testDate, true);
    expect(legs.data?.find((l) => l.id === r2.data!.legId)).toBeUndefined();
  });
});
