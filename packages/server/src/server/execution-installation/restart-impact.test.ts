import { expect, test } from "vitest";
import { isInactiveArchivedRestartError } from "./restart-impact.js";

test("only verified inactive archived history can be excluded from a legacy drain error", () => {
  const impact = { id: "archived", title: "History", status: "Codex session is not connected" };
  const record = {
    id: "archived",
    status: "idle" as const,
    archivedAt: new Date().toISOString(),
    activeTurn: null,
    pendingPermissions: [],
  };
  expect(isInactiveArchivedRestartError(impact, record)).toBe(true);
  expect(isInactiveArchivedRestartError(impact, undefined)).toBe(false);
  expect(isInactiveArchivedRestartError(impact, { ...record, id: "other" })).toBe(false);
  expect(isInactiveArchivedRestartError(impact, { ...record, status: "running" })).toBe(false);
  expect(isInactiveArchivedRestartError(impact, { ...record, archivedAt: null })).toBe(false);
  expect(isInactiveArchivedRestartError(impact, { ...record, activeTurn: undefined })).toBe(false);
  expect(isInactiveArchivedRestartError({ ...impact, status: "Unknown failure" }, record)).toBe(
    false,
  );
});
