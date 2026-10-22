import { expect } from "vitest";
import { ConfigWriterError } from "../config-writer.js";

/**
 * A failure after a config write was attempted surfaces as an uncertain write, with the original
 * failure kept in its cause chain. Assert both, so the test still pins what actually failed.
 */
export function expectUncertainConfigWrite(action: () => unknown, message: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigWriterError);
  expect((thrown as ConfigWriterError).code).toBe("uncertain");
  const messages: string[] = [];
  for (let cause: unknown = thrown; cause instanceof Error; cause = cause.cause) {
    messages.push(cause.message);
  }
  expect(messages.some((entry) => entry.includes(message))).toBe(true);
}
