import { useCallback, useState } from "react";

/** Async drop handlers retain their order until authoritative data changes or saving fails.
 * Keep current row objects so status/text updates during a save are never frozen.
 */
export function useOptimisticReorder<T>(
  data: T[],
  keyExtractor: (item: T, index: number) => string,
  onDrop: (items: T[]) => void | Promise<unknown>,
) {
  const signature = JSON.stringify(data.map(keyExtractor));
  const [preview, setPreview] = useState<{ base: string; keys: string[] } | null>(null);
  // Reconcile during render, before a stale preview can paint over a remote change.
  if (preview && preview.base !== signature) setPreview(null);
  const current = preview?.base === signature ? preview : null;
  let items = data;
  if (current) {
    const byKey = new Map(data.map((item, index) => [keyExtractor(item, index), item]));
    items = current.keys.map((key) => byKey.get(key)!);
  }
  const drop = useCallback(
    (ordered: T[]) => {
      const result = onDrop(ordered);
      if (!result) return; // Synchronous owners update their data in the drop event.
      const keys = ordered.map(keyExtractor);
      const available = new Set<string>(JSON.parse(signature));
      // Membership may have changed during a gesture. Never resurrect missing rows.
      const next =
        keys.length === available.size && keys.every((key) => available.has(key))
          ? { base: signature, keys }
          : null;
      setPreview(next);
      // Success alone is not a data acknowledgement: props may arrive on a later render.
      void result.catch(() => setPreview((value) => (value === next ? null : value)));
    },
    [onDrop, signature, keyExtractor],
  );
  return { items, drop };
}
