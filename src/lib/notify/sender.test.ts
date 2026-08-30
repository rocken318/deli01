import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * sendNotification の分岐検証（実 SMTP は叩かず nodemailer をモック）。
 */
const mock = vi.hoisted(() => ({
  smtpUrl: undefined as string | undefined,
  emailFrom: undefined as string | undefined,
  sendMail: vi.fn(async () => ({ messageId: "x" })),
}));

vi.mock("@/lib/env", () => ({
  env: {
    get smtpUrl() {
      return mock.smtpUrl;
    },
    get emailFrom() {
      return mock.emailFrom;
    },
  },
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mock.sendMail }) },
  createTransport: () => ({ sendMail: mock.sendMail }),
}));

import { sendNotification } from "./sender";

const base = {
  id: "1",
  channel: "email" as const,
  recipient: "a@example.com",
  subject: "s",
  body: "b",
};

afterEach(() => {
  mock.smtpUrl = undefined;
  mock.emailFrom = undefined;
  mock.sendMail.mockReset();
  mock.sendMail.mockResolvedValue({ messageId: "x" });
});

describe("sendNotification", () => {
  it("SMTP 未設定はスタブ sent（実送信しない）", async () => {
    expect(await sendNotification(base)).toBe("sent");
    expect(mock.sendMail).not.toHaveBeenCalled();
  });
  it("設定済み + メール宛先で実送信 sent", async () => {
    mock.smtpUrl = "smtp://x";
    mock.emailFrom = "from@example.com";
    expect(await sendNotification(base)).toBe("sent");
    expect(mock.sendMail).toHaveBeenCalledOnce();
  });
  it("設定済み + 電話番号宛先は skipped（誤送信しない）", async () => {
    mock.smtpUrl = "smtp://x";
    mock.emailFrom = "from@example.com";
    expect(await sendNotification({ ...base, recipient: "09012345678" })).toBe(
      "skipped",
    );
    expect(mock.sendMail).not.toHaveBeenCalled();
  });
  it("設定済み + line チャネルは skipped", async () => {
    mock.smtpUrl = "smtp://x";
    mock.emailFrom = "from@example.com";
    expect(await sendNotification({ ...base, channel: "line" })).toBe("skipped");
  });
  it("送信 throw は failed", async () => {
    mock.smtpUrl = "smtp://x";
    mock.emailFrom = "from@example.com";
    mock.sendMail.mockRejectedValueOnce(new Error("smtp down"));
    expect(await sendNotification(base)).toBe("failed");
  });
});
