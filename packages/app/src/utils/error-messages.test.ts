import { expect, test } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { isConnectionError, toErrorMessage } from "./error-messages";

const CONNECTION_LOST = "Lost connection to the host. Try again once it reconnects.";

test.each([
  new Error("Transport closed (code 1006)"),
  new Error("Transport not connected (status: disconnected)"),
  new Error("Liveness check timed out (15000ms)"),
  new Error("Timeout waiting for message (60000ms)"),
  "Error: Transport closed",
  new DaemonConnectionError("Anything at all"),
])("treats %s as a lost connection", (error) => {
  expect(isConnectionError(error)).toBe(true);
  expect(toErrorMessage(error)).toBe(CONNECTION_LOST);
});

test("keeps host messages and drops wire diagnostics", () => {
  const rpcError = Object.assign(
    new Error("Workspace is archived requestType=workspace.archive.request code=conflict"),
    { userMessage: "Workspace is archived" },
  );
  expect(toErrorMessage(rpcError)).toBe("Workspace is archived");
  expect(toErrorMessage(new Error("Name taken requestType=label.update code=conflict"))).toBe(
    "Name taken",
  );
  expect(isConnectionError(new Error("Name taken"))).toBe(false);
  expect(toErrorMessage(new Error("Name taken"))).toBe("Name taken");
});
