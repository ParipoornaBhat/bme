"use client";

/**
 * Unsaved annotation edits, kept in this browser (IndexedDB) so a refresh, a
 * closed tab or a failed save does not lose them. One draft per case and
 * series. It never leaves the device; Save is still what stores the work.
 */

const DB = "bme-annotation-drafts";
const STORE = "drafts";

export interface Draft {
  key: string;
  user: string;
  at: number;
  /** Hash of the saved annotation the edits were made on top of. */
  baseHash: number;
  length: number;
  /** Run-length pairs: value, count, value, count ... */
  runs: Uint32Array;
}

export const draftKey = (caseId: string, seriesId?: string | null) => `${caseId}|${seriesId || "primary"}`;

/** FNV-1a over the label volume; cheap, and enough to tell two versions apart. */
export function hashLabels(a: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function encode(a: Uint8Array): Uint32Array {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    const v = a[i];
    let j = i + 1;
    while (j < a.length && a[j] === v) j++;
    out.push(v, j - i);
    i = j;
  }
  return Uint32Array.from(out);
}

export function decodeDraft(d: Draft): Uint8Array {
  const a = new Uint8Array(d.length);
  let p = 0;
  for (let i = 0; i + 1 < d.runs.length; i += 2) {
    const v = d.runs[i];
    const n = d.runs[i + 1];
    if (v) a.fill(v, p, p + n);
    p += n;
  }
  return a;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  try {
    const db = await open();
    return await new Promise<T | undefined>((resolve) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      t.oncomplete = () => db.close();
    });
  } catch {
    return undefined;
  }
}

export async function saveDraft(key: string, user: string, labels: Uint8Array, baseHash: number): Promise<void> {
  const draft: Draft = { key, user, at: Date.now(), baseHash, length: labels.length, runs: encode(labels) };
  await tx("readwrite", (s) => s.put(draft));
}

export async function loadDraft(key: string): Promise<Draft | undefined> {
  return tx<Draft>("readonly", (s) => s.get(key) as IDBRequest<Draft>);
}

export async function deleteDraft(key: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(key));
}
