import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import type { ScheduleService } from "../schedule/service.js";

export class FactoryScheduleInspectionError extends Error {
  constructor(readonly state: "unavailable" | "changed") {
    super(`Factory native schedule inspection is ${state}.`);
    this.name = "FactoryScheduleInspectionError";
  }
}

interface ScheduleInspectionRequest {
  scheduleId: string;
  assertCurrent(): void;
}

/** Startup-only reader of the existing service. It grants no settlement or mutation authority. */
export function createFactoryScheduleInspection() {
  let source: Pick<ScheduleService, "inspect"> | undefined;
  let capturedInspect: ScheduleService["inspect"] | undefined;
  let revoked = false;
  return Object.freeze({
    activate(service: Pick<ScheduleService, "inspect">): void {
      if (revoked || source || typeof service.inspect !== "function") {
        throw new FactoryScheduleInspectionError("unavailable");
      }
      source = service;
      capturedInspect = service.inspect;
    },
    revoke(): void {
      revoked = true;
      source = undefined;
      capturedInspect = undefined;
    },
    async inspect(request: ScheduleInspectionRequest): Promise<StoredSchedule> {
      const { scheduleId, assertCurrent } = request;
      if (typeof scheduleId !== "string" || !/^[0-9a-f]{8}$/.test(scheduleId)) {
        throw new Error("Factory native schedule ID is invalid.");
      }
      if (typeof assertCurrent !== "function") {
        throw new Error("Factory native schedule owner assertion is required.");
      }
      const service = source;
      const inspect = capturedInspect;
      if (!service || !inspect || revoked) {
        throw new FactoryScheduleInspectionError("unavailable");
      }
      const boundService = service;
      function guard(): void {
        assertCurrent();
        if (
          revoked ||
          source !== boundService ||
          capturedInspect !== inspect ||
          boundService.inspect !== inspect
        ) {
          throw new FactoryScheduleInspectionError("changed");
        }
      }
      guard();
      const schedule = structuredClone(await inspect.call(service, scheduleId));
      guard();
      if (schedule.id !== scheduleId) {
        throw new FactoryScheduleInspectionError("changed");
      }
      return schedule;
    },
  });
}
