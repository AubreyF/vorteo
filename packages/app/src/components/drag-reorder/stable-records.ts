import { useRef } from "react";

// Keeps dnd-kit handle records stable so memoized rows do not re-render on every drag frame.

function areRecordsEqual(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

export function useShallowStableRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const stableRef = useRef(value);
  if (!areRecordsEqual(stableRef.current, value)) {
    stableRef.current = value;
  }
  return stableRef.current;
}

export function useStableListenerRecord(
  listeners: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const latestListenersRef = useRef(listeners);
  latestListenersRef.current = listeners;
  const listenerKeys = Object.keys(listeners ?? {}).sort();
  const listenerKeySignature = listenerKeys.join("\u0000");
  const stableListenersRef = useRef<{
    keySignature: string;
    listeners: Record<string, unknown> | undefined;
  }>(undefined);
  if (stableListenersRef.current?.keySignature !== listenerKeySignature) {
    stableListenersRef.current = {
      keySignature: listenerKeySignature,
      listeners:
        listenerKeys.length === 0
          ? undefined
          : Object.fromEntries(
              listenerKeys.map((key) => [
                key,
                (...args: unknown[]) => {
                  const listener = latestListenersRef.current?.[key];
                  if (typeof listener === "function") {
                    return Reflect.apply(listener, undefined, args);
                  }
                },
              ]),
            ),
    };
  }
  return stableListenersRef.current.listeners;
}
