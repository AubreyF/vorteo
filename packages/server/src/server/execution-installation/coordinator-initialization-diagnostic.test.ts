import { expect, test, vi } from "vitest";
import { z } from "zod";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  INITIALIZATION_PHASES,
  initializationClassification,
  withInitializationDiagnostic,
} from "./coordinator-initialization-diagnostic.js";

test.each(INITIALIZATION_PHASES)("reports %s and keeps every operation refused", async (phase) => {
  const initialize = vi.fn(async (mark: (value: typeof phase) => void) => {
    mark(phase);
    throw Object.assign(new Error("password=secret /private/journal.json"), {
      code: "EACCES",
      name: "private-owner",
    });
  });
  const service = await withInitializationDiagnostic(initialize);
  expect(service?.unavailableReason).toContain(`phase=${phase} class=error code=EACCES`);
  expect(service?.unavailableReason).not.toMatch(/secret|private|journal/);
  expect(() => service!.list()).toThrow(BootstrapRequestConflict);
  await expect(service!.prepare({} as never)).rejects.toBeInstanceOf(BootstrapRequestConflict);
  await expect(service!.decide({} as never)).rejects.toBeInstanceOf(BootstrapRequestConflict);
  expect(initialize).toHaveBeenCalledTimes(1);
});

test("conflict failure remains unavailable without copying its message", async () => {
  const service = await withInitializationDiagnostic(async () => {
    throw new BootstrapRequestConflict("token=private-owner /path");
  });
  expect(service?.unavailableReason).toContain("class=conflict code=none");
  expect(service?.unavailableReason).not.toMatch(/private-owner|\/path/);
  expect(() => service!.list()).toThrow(BootstrapRequestConflict);
});

test.each([
  new TypeError("secret"),
  new SyntaxError("secret"),
  new RangeError("secret"),
  "secret",
  { name: "Error", code: "SECRET", message: "secret" },
  z.object({ privateOwner: z.string() }).safeParse({ privateOwner: 42 }).error,
])("redacts arbitrary error and schema contents %#", (error) => {
  expect(initializationClassification(error)).not.toMatch(/secret|privateOwner|42/i);
});

test("does not invoke error getters or serialize thrown values", () => {
  const getter = vi.fn(() => {
    throw new Error("private");
  });
  const value = Object.defineProperties(
    {},
    {
      code: { get: getter },
      name: { get: getter },
      message: { get: getter },
      stack: { get: getter },
      toJSON: { get: getter },
    },
  );
  expect(initializationClassification(value)).toBe("class=unclassified code=none");
  expect(getter).not.toHaveBeenCalled();
  const proxy = new Proxy({}, { getPrototypeOf: getter });
  expect(initializationClassification(proxy)).toBe("class=unclassified code=none");
});

test("preserves successful and absent initialization without new work", async () => {
  expect(await withInitializationDiagnostic(async () => undefined)).toBeUndefined();
  const service = { list: vi.fn(), prepare: vi.fn(), decide: vi.fn() };
  expect(await withInitializationDiagnostic(async () => service)).toBe(service);
  expect(service.list).not.toHaveBeenCalled();
  expect(service.prepare).not.toHaveBeenCalled();
  expect(service.decide).not.toHaveBeenCalled();
});
