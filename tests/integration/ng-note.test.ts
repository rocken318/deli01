import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  listTherapistNgNotes,
  setTherapistNgNote,
} from "@/lib/therapist/ng-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

// Fetch aoi's therapist id from seed
async function getAoiId(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    select id from therapists where slug = 'aoi' limit 1
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error("seed therapist 'aoi' not found");
  return id;
}

afterAll(async () => {
  // Reset aoi's ng_note to null after tests
  await sql`update therapists set ng_note = null where slug = 'aoi'`;
  await sql.end({ timeout: 5 });
});

describe("setTherapistNgNote / listTherapistNgNotes", () => {
  it("NG条件メモを設定して取得できる", async () => {
    const therapistId = await getAoiId();

    const setResult = await setTherapistNgNote({
      therapistId,
      ngNote: "自宅送迎NG・深夜NG",
    });
    expect(setResult.ok).toBe(true);

    const listResult = await listTherapistNgNotes();
    expect(listResult.ok).toBe(true);
    const found = listResult.data?.find((r) => r.therapistId === therapistId);
    expect(found).toBeDefined();
    expect(found?.ngNote).toBe("自宅送迎NG・深夜NG");
  });

  it("空文字は null になる", async () => {
    const therapistId = await getAoiId();

    const setResult = await setTherapistNgNote({ therapistId, ngNote: "" });
    expect(setResult.ok).toBe(true);

    const listResult = await listTherapistNgNotes();
    expect(listResult.ok).toBe(true);
    const found = listResult.data?.find((r) => r.therapistId === therapistId);
    expect(found?.ngNote).toBeNull();
  });

  it("1000字超はエラーになる", async () => {
    const therapistId = await getAoiId();
    const longNote = "あ".repeat(1001);

    const result = await setTherapistNgNote({ therapistId, ngNote: longNote });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("1000字ちょうどは保存できる", async () => {
    const therapistId = await getAoiId();
    const exactNote = "あ".repeat(1000);

    const result = await setTherapistNgNote({ therapistId, ngNote: exactNote });
    expect(result.ok).toBe(true);
  });
});
