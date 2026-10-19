import { demoStorageName } from "@/demo/mode";
import {
  QueueEditDraftSchema,
  type QueueEditDraft,
  type QueueEditDraftStorage,
} from "./edit-draft";

export function createQueueEditDraftStorage(
  name = demoStorageName("paseo-queue-edit-drafts"),
): QueueEditDraftStorage {
  async function transaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, finish: (value: T) => void) => void,
  ): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("drafts", { keyPath: "id" });
      opening.onsuccess = () => resolve(opening.result);
      opening.addEventListener("error", () => reject(opening.error));
      opening.onblocked = () =>
        reject(new Error("Close other Vorteo tabs to open saved queue edits."));
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("drafts", mode, { durability: "strict" });
        let result: T;
        tx.oncomplete = () => resolve(result);
        tx.addEventListener("abort", () =>
          reject(tx.error ?? new Error("The queue edit could not be saved on this device.")),
        );
        tx.addEventListener("error", () => reject(tx.error));
        try {
          run(tx.objectStore("drafts"), (value) => {
            result = value;
          });
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    } finally {
      db.close();
    }
  }
  function change(
    id: string,
    expected: number | null,
    value: QueueEditDraft | null,
  ): Promise<boolean> {
    if (value) {
      QueueEditDraftSchema.parse(value);
      if (value.revision !== (expected === null ? 0 : expected + 1))
        throw new Error("Invalid queue draft revision.");
    }
    return transaction("readwrite", (store, finish) => {
      const read = store.get(id);
      read.onsuccess = () => {
        if ((read.result?.revision ?? null) !== expected) return finish(false);
        if (value) store.put(value);
        else store.delete(id);
        finish(true);
      };
    });
  }
  return {
    list: async () => {
      const records = await transaction<unknown[]>("readonly", (store, finish) => {
        const read = store.getAll();
        read.onsuccess = () => finish(read.result);
      });
      return records.map((record) => QueueEditDraftSchema.parse(record));
    },
    exchange: (draft, expected) => change(draft.id, expected, draft),
    remove: (id, expected) => change(id, expected, null),
  };
}
