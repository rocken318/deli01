import { describe, expect, it } from "vitest";
import {
  buildNotification,
  notificationDedupeKey,
  reminderSchedule,
} from "./build";

describe("reminderSchedule（受入 L1131: 前日と2時間前に1回ずつ）", () => {
  const startAt = new Date("2026-09-10T10:00:00.000Z"); // 19:00 JST
  const entries = reminderSchedule({ reservationId: "res-1", startAt });

  it("前日（−24h）と2時間前（−2h）のちょうど2件を返す", () => {
    expect(entries).toHaveLength(2);
    const byKind = Object.fromEntries(entries.map((e) => [e.kind, e]));
    expect(byKind["reminder_prev_day"]!.scheduledFor.toISOString()).toBe(
      "2026-09-09T10:00:00.000Z",
    );
    expect(byKind["reminder_2h"]!.scheduledFor.toISOString()).toBe(
      "2026-09-10T08:00:00.000Z",
    );
  });

  it("dedupe_key は '{kind}:{reservationId}'（DB unique と対）", () => {
    const keys = entries.map((e) => e.dedupeKey).sort();
    expect(keys).toEqual(["reminder_2h:res-1", "reminder_prev_day:res-1"]);
    expect(notificationDedupeKey("weekly_report", "2026-09-07")).toBe(
      "weekly_report:2026-09-07",
    );
  });
});

describe("buildNotification（{{変数}} 補間 = dispatch の interpolate 再利用）", () => {
  it("subject / body の両方を補間する", () => {
    const out = buildNotification({
      subjectTemplate: "【リマインド】{{日時}}",
      bodyTemplate: "{{顧客名}} 様\n{{コース}} / {{セラピスト}}",
      vars: { 日時: "09/10 19:00", 顧客名: "山田", コース: "60分", セラピスト: "あおい" },
    });
    expect(out.subject).toBe("【リマインド】09/10 19:00");
    expect(out.body).toBe("山田 様\n60分 / あおい");
  });

  it("未定義の変数は空文字になり落ちない（dispatch と同じ保証）", () => {
    const out = buildNotification({
      subjectTemplate: "{{未定義}}A",
      bodyTemplate: "{{ 顧客名 }}B{{謎}}",
      vars: { 顧客名: "山田" },
    });
    expect(out.subject).toBe("A");
    expect(out.body).toBe("山田B");
  });
});
