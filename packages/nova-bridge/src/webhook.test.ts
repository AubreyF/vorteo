import { expect, it } from "vitest";
import { assertWebhookBodySize, deliverWebhook } from "./webhook.js";

it("counts UTF8 bytes and refuses oversized bodies before URL or network handling", async () => {
  const boundary = "é".repeat(131072);
  expect(() => assertWebhookBodySize(boundary)).not.toThrow();
  expect(() => assertWebhookBodySize(boundary + "x")).toThrow("256 KiB");
  await expect(
    deliverWebhook({ url: "not-a-url", headers: {}, body: boundary + "x" }),
  ).rejects.toThrow("256 KiB");
});
