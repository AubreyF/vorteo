import type { ControllerOwnership } from "@getpaseo/server/factory-ownership";
export type { ControllerOwnership } from "@getpaseo/server/factory-ownership";

/** Requires the existing Linux supervisor's retained lifetime descriptors. */
export function captureControllerOwnership(environment?: NodeJS.ProcessEnv): ControllerOwnership;
