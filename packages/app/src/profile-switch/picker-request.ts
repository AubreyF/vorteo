import { create } from "zustand";

interface ProfilePickerRequestState {
  /** `${serverId}:${agentId}` of the thread whose preset picker should open. */
  agentKey: string | null;
}

const useProfilePickerRequestStore = create<ProfilePickerRequestState>(() => ({ agentKey: null }));

interface ProfilePickerTarget {
  serverId: string;
  agentId: string;
}

function agentKey(target: ProfilePickerTarget): string {
  return `${target.serverId}:${target.agentId}`;
}

/** Asks the thread's composer to open its preset picker, for actions outside the composer. */
export function requestProfilePicker(target: ProfilePickerTarget): void {
  useProfilePickerRequestStore.setState({ agentKey: agentKey(target) });
}

export function clearProfilePickerRequest(): void {
  useProfilePickerRequestStore.setState({ agentKey: null });
}

export function useIsProfilePickerRequested(target: ProfilePickerTarget): boolean {
  const key = agentKey(target);
  return useProfilePickerRequestStore((state) => state.agentKey === key);
}
