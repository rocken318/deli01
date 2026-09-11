import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  listTransportLedger,
  getTransportForTherapist,
  saveTransport,
  deleteTransport,
} from "@/lib/transport/actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let aoiId: string;

beforeAll(async () => {
  aoiId = (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id;
  // 既存の送り台帳があれば削除（他テストとの干渉回避）
  await sql`delete from therapist_transport where therapist_id = ${aoiId}::uuid`;
});

afterAll(async () => {
  await sql`delete from therapist_transport where therapist_id = ${aoiId}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("saveTransport / getTransportForTherapist", () => {
  it("送り先を登録できる（複数ルート）", async () => {
    const r = await saveTransport({
      therapistId: aoiId,
      note: "週末は寮送り優先",
      routes: [
        { kind: "home", destination: "○○市△△町1-2-3", roundTripMin: 40 },
        { kind: "dorm", destination: "〇〇寮 303号室", roundTripMin: 20 },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("getTransportForTherapist で取得できる（route順・種別・往復分）", async () => {
    const r = await getTransportForTherapist(aoiId);
    expect(r.ok).toBe(true);
    expect(r.data?.note).toBe("週末は寮送り優先");
    expect(r.data?.routes).toHaveLength(2);
    expect(r.data?.routes[0]?.kind).toBe("home");
    expect(r.data?.routes[0]?.roundTripMin).toBe(40);
    expect(r.data?.routes[1]?.kind).toBe("dorm");
    expect(r.data?.routes[1]?.roundTripMin).toBe(20);
  });

  it("listTransportLedger に therapistName 付きで表示される", async () => {
    const r = await listTransportLedger();
    expect(r.ok).toBe(true);
    const row = r.data?.find((x) => x.therapistId === aoiId);
    expect(row).toBeDefined();
    expect(typeof row?.therapistName).toBe("string");
    expect(row?.routes).toHaveLength(2);
  });

  it("再保存（upsert）でルートが入れ替わる", async () => {
    const r = await saveTransport({
      therapistId: aoiId,
      note: "自宅のみ",
      routes: [
        { kind: "home", destination: "新住所1-2-3", roundTripMin: 30 },
      ],
    });
    expect(r.ok).toBe(true);
    const g = await getTransportForTherapist(aoiId);
    expect(g.data?.routes).toHaveLength(1);
    expect(g.data?.note).toBe("自宅のみ");
    expect(g.data?.routes[0]?.destination).toBe("新住所1-2-3");
  });

  it("deleteTransport で削除される", async () => {
    const r = await deleteTransport(aoiId);
    expect(r.ok).toBe(true);
    const g = await getTransportForTherapist(aoiId);
    expect(g.data).toBeNull();
  });
});
