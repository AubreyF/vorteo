import { demoStorageName } from "@/demo/mode";
import {
  type AttachmentStore,
  type AttachmentMetadata,
  type SaveAttachmentInput,
} from "@/attachments/types";
import {
  blobToBase64,
  generateAttachmentId,
  normalizeMimeType,
  parseDataUrl,
} from "@/attachments/utils";

interface StoredBlobRecord {
  id: string;
  blob: Blob;
  createdAt: number;
  fileName: string | null;
}

const DB_NAME = "paseo-attachment-bytes";
const STORE_NAME = "attachments";
const DB_VERSION = 1;

function ensureIndexedDb(): IDBFactory {
  const idb = globalThis.indexedDB;
  if (!idb) {
    throw new Error("IndexedDB is unavailable in this runtime.");
  }
  return idb;
}

function openAttachmentDb(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = ensureIndexedDb().open(databaseName, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.addEventListener("success", () => resolve(request.result));

    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Failed to open attachment IndexedDB."));
    });
  });
}

function runTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode, { durability: "strict" });
    const store = transaction.objectStore(STORE_NAME);
    const request = run(store);

    transaction.addEventListener("complete", () => resolve(request.result));

    request.addEventListener("error", () => {
      reject(request.error ?? new Error("IndexedDB transaction request failed."));
    });

    transaction.addEventListener("error", () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    });
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    });
  });
}

async function sourceToBlob(input: SaveAttachmentInput): Promise<{ blob: Blob; mimeType: string }> {
  const source = input.source;
  if (source.kind === "bytes") {
    const mimeType = normalizeMimeType(input.mimeType);
    const buffer = new ArrayBuffer(source.bytes.byteLength);
    new Uint8Array(buffer).set(source.bytes);
    return {
      blob: new Blob([buffer], { type: mimeType }),
      mimeType,
    };
  }

  if (source.kind === "blob") {
    const mimeType = normalizeMimeType(input.mimeType ?? source.blob.type);
    const blob =
      source.blob.type === mimeType
        ? source.blob
        : source.blob.slice(0, source.blob.size, mimeType);
    return { blob, mimeType };
  }

  if (source.kind === "data_url") {
    const parsed = parseDataUrl(source.dataUrl);
    const response = await fetch(source.dataUrl);
    const blob = await response.blob();
    const mimeType = normalizeMimeType(input.mimeType ?? parsed.mimeType ?? blob.type);
    return {
      blob: blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType),
      mimeType,
    };
  }

  const response = await fetch(source.uri);
  const blob = await response.blob();
  const mimeType = normalizeMimeType(input.mimeType ?? blob.type);
  return {
    blob: blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType),
    mimeType,
  };
}

async function loadBlob(db: IDBDatabase, id: string): Promise<Blob> {
  const record = await runTx<StoredBlobRecord | undefined>(db, "readonly", (store) =>
    store.get(id),
  );
  if (!record?.blob) {
    throw new Error(`Attachment ${id} was not found in IndexedDB.`);
  }
  return record.blob;
}

export function createIndexedDbAttachmentStore(
  databaseName = demoStorageName(DB_NAME),
): AttachmentStore {
  return {
    storageType: "web-indexeddb",

    async save(input): Promise<AttachmentMetadata> {
      const id = input.id ?? generateAttachmentId();
      const createdAt = Date.now();
      const { blob, mimeType } = await sourceToBlob(input);
      const fileName = input.fileName ?? null;
      const db = await openAttachmentDb(databaseName);

      try {
        await runTx(db, "readwrite", (store) =>
          store.put({ id, blob, createdAt, fileName } satisfies StoredBlobRecord),
        );
      } finally {
        db.close();
      }

      return {
        id,
        mimeType,
        storageType: "web-indexeddb",
        storageKey: id,
        fileName,
        byteSize: blob.size,
        createdAt,
      };
    },

    async encodeBase64({ attachment }): Promise<string> {
      const db = await openAttachmentDb(databaseName);
      try {
        const blob = await loadBlob(db, attachment.storageKey);
        return await blobToBase64(blob);
      } finally {
        db.close();
      }
    },

    async resolvePreviewUrl({ attachment }): Promise<string> {
      const db = await openAttachmentDb(databaseName);
      try {
        const blob = await loadBlob(db, attachment.storageKey);
        return URL.createObjectURL(blob);
      } finally {
        db.close();
      }
    },

    async releasePreviewUrl({ url }): Promise<void> {
      URL.revokeObjectURL(url);
    },

    async delete({ attachment }): Promise<void> {
      const db = await openAttachmentDb(databaseName);
      try {
        await runTx(db, "readwrite", (store) => store.delete(attachment.storageKey));
      } finally {
        db.close();
      }
    },

    async garbageCollect({ referencedIds }): Promise<void> {
      const db = await openAttachmentDb(databaseName);
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          const store = tx.objectStore(STORE_NAME);
          const cursorRequest = store.openCursor();

          cursorRequest.addEventListener("error", () => {
            reject(
              cursorRequest.error ?? new Error("Failed to iterate IndexedDB attachment store."),
            );
          });

          cursorRequest.addEventListener("success", () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              return;
            }

            const key = String(cursor.key);
            if (!referencedIds.has(key)) {
              cursor.delete();
            }
            cursor.continue();
          });

          tx.addEventListener("error", () => {
            reject(tx.error ?? new Error("Failed to garbage collect IndexedDB attachments."));
          });
          tx.addEventListener("complete", () => resolve());
          tx.addEventListener("abort", () =>
            reject(tx.error ?? new Error("Attachment cleanup aborted.")),
          );
        });
      } finally {
        db.close();
      }
    },
  };
}
