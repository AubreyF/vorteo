import { afterEach, expect, test, vi } from "vitest";
import { observeNativeMaintenanceServices } from "./coordinator-bootstrap-maintenance-health.js";
import { resolveNativeMaintenanceExecutorSetup } from "./coordinator-bootstrap-maintenance-service-producer.js";

vi.mock("./coordinator-bootstrap-maintenance-service-producer.js", () => ({
  resolveNativeMaintenanceExecutorSetup: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

const input = () => ({
  installationId: "fixture-installation",
  stateDirectory: "/unused-health-fixture",
  signal: new AbortController().signal,
});

test("an aborted observation performs no registration discovery", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  await expect(
    observeNativeMaintenanceServices({ ...input(), signal: controller.signal }),
  ).rejects.toThrow("caller stopped");
  expect(resolveNativeMaintenanceExecutorSetup).not.toHaveBeenCalled();
});

test("missing protected registration cannot become healthy or an empty success", async () => {
  vi.mocked(resolveNativeMaintenanceExecutorSetup).mockRejectedValue(
    new Error("registration absent"),
  );
  await expect(observeNativeMaintenanceServices(input())).rejects.toThrow("registration absent");
  expect(resolveNativeMaintenanceExecutorSetup).toHaveBeenCalledOnce();
});

test("caller cancellation bounds a hung discovery without a second attempt", async () => {
  vi.mocked(resolveNativeMaintenanceExecutorSetup).mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const observation = observeNativeMaintenanceServices({ ...input(), signal: controller.signal });
  controller.abort(new Error("observation expired"));
  await expect(observation).rejects.toThrow("observation expired");
  expect(resolveNativeMaintenanceExecutorSetup).toHaveBeenCalledOnce();
});
