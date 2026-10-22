import { useCallback, useEffect, useRef } from "react";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";

/**
 * Reports a failed one-off action as a toast that clears itself. Controls keep the user's
 * input so they can retry, and no error text stays behind in the control.
 */
export function useReportActionError(): (error: unknown) => void {
  const toast = useToast();
  return useCallback((error: unknown) => toast.error(toErrorMessage(error)), [toast]);
}

/** Calls `reset` when the host reconnects, so errors from the lost connection disappear. */
export function useResetOnReconnect(serverId: string | null | undefined, reset: () => void): void {
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const wasConnected = useRef(connected);
  const resetRef = useRef(reset);
  useEffect(() => {
    resetRef.current = reset;
  }, [reset]);
  useEffect(() => {
    if (connected && !wasConnected.current) resetRef.current();
    wasConnected.current = connected;
  }, [connected]);
}
