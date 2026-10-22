import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { profileSwitchReason } from "./reason";

const timestamp = new Date("2026-10-22T12:00:00Z");

function reply(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp };
}

describe("profileSwitchReason", () => {
  it("attributes a switch after a quota exhaustion reply to quota", () => {
    const items: StreamItem[] = [
      reply("a", "Working on it."),
      reply("b", "[System Error] Usage limit reached.\n\ncode: quota_exhausted"),
      { kind: "user_message", id: "u", text: "Continue", timestamp },
    ];
    expect(profileSwitchReason(items)).toBe("quota");
  });

  it("treats a switch after an ordinary reply as manual", () => {
    const items: StreamItem[] = [
      reply("a", "[System Error] Usage limit reached.\n\ncode: quota_exhausted"),
      reply("b", "Done after the reset."),
    ];
    expect(profileSwitchReason(items)).toBe("manual");
    expect(profileSwitchReason([])).toBe("manual");
  });
});
