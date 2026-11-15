import * as nifti from "nifti-reader-js";

export type StreamInfo = {
  dims: [number, number, number];
  spacing: [number, number, number];
  sliceBytes: number;
  totalSlices: number;
  voxOffset: number;
  bytesPerVoxel: number;
  totalBytes: number;
  datatypeCode: number;
  buffer: ArrayBuffer;
  growingBuffer: Uint8Array;
};

export type StreamNiftiOptions = {
  signal?: AbortSignal;
  caseId?: string;
  onHeader?: (hdr: any, info: StreamInfo) => void;
  onProgress?: (slicesDone: number, totalSlices: number, bytesDone: number, bytesTotal: number) => void;
};

export type CachedVolume = {
  gz: ArrayBuffer;
  bytes: number;
  savedAt: number;
};

const DB_NAME = "bme-volumes";
const STORE_NAME = "files";
const DB_VERSION = 1;
const MAX_CACHE_BYTES = 800 * 1024 * 1024; // 800 MB

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      return reject(new Error("IndexedDB not available"));
    }
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieve a cached volume by caseId from IndexedDB.
 * Returns null if not found or if IndexedDB is unavailable/blocked.
 */
export async function getCachedVolume(caseId: string): Promise<CachedVolume | null> {
  try {
    const db = await openDB();
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, "readwrite");
    } catch {
      tx = db.transaction(STORE_NAME, "readonly");
    }
    const store = tx.objectStore(STORE_NAME);
    const item = await new Promise<CachedVolume | null>((resolve, reject) => {
      const req = store.get(caseId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (item && tx.mode === "readwrite") {
      try {
        item.savedAt = Date.now();
        store.put(item, caseId);
      } catch {
        // Ignore write failures when updating LRU timestamp
      }
    }
    return item;
  } catch {
    return null;
  }
}

/**
 * Store a compressed volume (gzip bytes) in IndexedDB with LRU eviction to stay under 800 MB.
 */
export async function putCachedVolume(caseId: string, gz: ArrayBuffer): Promise<void> {
  try {
    const bytes = gz.byteLength;
    if (bytes > MAX_CACHE_BYTES) return; // Individual item exceeds capacity

    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    // Collect all existing keys to evaluate cache size and evict LRU items
    const items: Array<{ key: string; bytes: number; savedAt: number }> = [];
    let currentTotal = 0;

    await new Promise<void>((resolve, reject) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const val = cursor.value as CachedVolume;
          const k = String(cursor.key);
          if (k !== caseId) {
            const itemBytes = val?.bytes || (val?.gz ? val.gz.byteLength : 0);
            const itemSavedAt = val?.savedAt || 0;
            items.push({ key: k, bytes: itemBytes, savedAt: itemSavedAt });
            currentTotal += itemBytes;
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

    // Evict oldest items if adding new entry would exceed MAX_CACHE_BYTES
    if (currentTotal + bytes > MAX_CACHE_BYTES) {
      items.sort((a, b) => a.savedAt - b.savedAt);
      for (const item of items) {
        if (currentTotal + bytes <= MAX_CACHE_BYTES) break;
        store.delete(item.key);
        currentTotal -= item.bytes;
      }
    }

    const savedAt = Date.now();
    store.put({ gz, bytes, savedAt }, caseId);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // Private windows or storage quota errors - skip caching cleanly
  }
}

let activePrefetchController: AbortController | null = null;

/**
 * Prefetch a volume in the background with low priority and store it in IndexedDB.
 * Only one prefetch runs at a time; starting a new one cancels the previous.
 */
export async function prefetchVolume(caseId: string, url: string): Promise<void> {
  try {
    const existing = await getCachedVolume(caseId);
    if (existing) return;

    if (activePrefetchController) {
      activePrefetchController.abort();
    }
    const ctrl = new AbortController();
    activePrefetchController = ctrl;

    const res = await fetch(url, {
      signal: ctrl.signal,
      priority: "low" as RequestPriority,
    });
    if (!res.ok) return;

    const gz = await res.arrayBuffer();
    if (!ctrl.signal.aborted && gz.byteLength > 0) {
      await putCachedVolume(caseId, gz);
    }
  } catch {
    // Ignore aborted or network errors in background prefetch
  } finally {
    if (activePrefetchController?.signal.aborted) {
      activePrefetchController = null;
    }
  }
}

export function cancelPrefetch(): void {
  if (activePrefetchController) {
    activePrefetchController.abort();
    activePrefetchController = null;
  }
}

async function collectStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalLength += value.length;
      }
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result.buffer;
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
}

function extractCaseId(url: string): string | undefined {
  try {
    const u = new URL(url, "http://localhost");
    const parts = u.pathname.split("/");
    const volIdx = parts.indexOf("volume");
    if (volIdx >= 0 && parts[volIdx + 1]) {
      return decodeURIComponent(parts[volIdx + 1]);
    }
  } catch {}
  return undefined;
}

/**
 * Stream and decompress a NIfTI-1 file while notifying slice-by-slice progress.
 * Caches the compressed bytes to IndexedDB via stream teeing.
 */
export async function streamNifti(
  url: string,
  options: StreamNiftiOptions = {}
): Promise<{ hdr: any; buffer: ArrayBuffer }> {
  const { signal, onHeader, onProgress } = options;
  const caseId = options.caseId || extractCaseId(url);

  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const res = await fetch(url, { signal });
  if (!res.ok) {
    const errorJson = await res.json().catch(() => ({}));
    throw new Error((errorJson as { error?: string }).error ?? "load failed");
  }

  if (!res.body) {
    throw new Error("Response body is empty");
  }

  // Tee the stream to cache compressed bytes in background without blocking decompression
  const [streamForParse, streamForCache] = res.body.tee();

  if (caseId) {
    collectStream(streamForCache, signal)
      .then((gz) => {
        if (!signal?.aborted && gz.byteLength > 0) {
          return putCachedVolume(caseId, gz);
        }
      })
      .catch(() => {});
  } else {
    streamForCache.cancel().catch(() => {});
  }

  const reader1 = streamForParse.getReader();
  const first = await reader1.read();
  if (first.done || !first.value || first.value.length === 0) {
    throw new Error("Empty response body");
  }

  // Read enough initial bytes to check gzip magic 1f 8b
  let initialBytes = first.value;
  while (initialBytes.length < 2) {
    const next = await reader1.read();
    if (next.done || !next.value) break;
    const combined = new Uint8Array(initialBytes.length + next.value.length);
    combined.set(initialBytes, 0);
    combined.set(next.value, initialBytes.length);
    initialBytes = combined;
  }

  const isGzip = initialBytes.length >= 2 && initialBytes[0] === 0x1f && initialBytes[1] === 0x8b;

  const rawStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(initialBytes);
    },
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException("Aborted", "AbortError"));
        return;
      }
      const { done, value } = await reader1.read();
      if (done) {
        controller.close();
      } else if (value) {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader1.cancel(reason);
    },
  });

  const decompressedStream = isGzip
    ? (rawStream as any).pipeThrough(new DecompressionStream("gzip"))
    : rawStream;

  const decompReader = decompressedStream.getReader();

  const abortListener = () => {
    decompReader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abortListener);

  try {
    let headerReady = false;
    let hdr: any = null;
    let info: StreamInfo | null = null;
    const initialChunks: Uint8Array[] = [];
    let bytesReceived = 0;
    let growingBuffer: Uint8Array | null = null;
    let totalBytes = 0;
    let totalSlices = 0;
    let sliceBytes = 0;
    let voxOffset = 352;
    let lastSlicesDone = 0;

    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const { done, value } = await decompReader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      if (!headerReady) {
        initialChunks.push(value);
        bytesReceived += value.length;

        if (bytesReceived >= 352) {
          const tempBuf = new Uint8Array(bytesReceived);
          let pos = 0;
          for (const ch of initialChunks) {
            tempBuf.set(ch, pos);
            pos += ch.length;
          }

          if (nifti.isNIFTI(tempBuf.buffer)) {
            try {
              const parsedHdr = nifti.readHeader(tempBuf.buffer);
              const expectedOffset = Math.max(352, Math.round(parsedHdr.vox_offset) || 352);

              if (bytesReceived >= expectedOffset) {
                hdr = parsedHdr;
                voxOffset = expectedOffset;
                headerReady = true;

                const nx = hdr.dims[1];
                const ny = hdr.dims[2];
                const nz = hdr.dims[3];
                const bytesPerVoxel = (hdr.numBitsPerVoxel || 16) / 8;
                totalSlices = nz;
                sliceBytes = nx * ny * bytesPerVoxel;
                totalBytes = voxOffset + nx * ny * nz * bytesPerVoxel;

                growingBuffer = new Uint8Array(totalBytes);
                growingBuffer.set(tempBuf.subarray(0, Math.min(bytesReceived, totalBytes)), 0);

                info = {
                  dims: [nx, ny, nz],
                  spacing: [
                    Math.abs(hdr.pixDims?.[1]) || 1,
                    Math.abs(hdr.pixDims?.[2]) || 1,
                    Math.abs(hdr.pixDims?.[3]) || 1,
                  ],
                  sliceBytes,
                  totalSlices,
                  voxOffset,
                  bytesPerVoxel,
                  totalBytes,
                  datatypeCode: hdr.datatypeCode,
                  buffer: growingBuffer.buffer as unknown as ArrayBuffer,
                  growingBuffer,
                };

                onHeader?.(hdr, info!);

                const initialSlices = bytesReceived >= voxOffset
                  ? Math.min(totalSlices, Math.floor((bytesReceived - voxOffset) / sliceBytes))
                  : 0;
                lastSlicesDone = initialSlices;
                if (initialSlices > 0) {
                  onProgress?.(initialSlices, totalSlices, Math.min(bytesReceived, totalBytes), totalBytes);
                }
              }
            } catch {
              // Not enough bytes for full header extensions yet, continue reading
            }
          }
        }
      } else {
        // Header already parsed, write chunk directly into growingBuffer
        const toCopy = Math.min(value.length, totalBytes - bytesReceived);
        if (toCopy > 0 && growingBuffer) {
          growingBuffer.set(value.subarray(0, toCopy), bytesReceived);
        }
        bytesReceived += value.length;

        const currentSlicesDone = bytesReceived >= voxOffset
          ? Math.min(totalSlices, Math.floor((bytesReceived - voxOffset) / sliceBytes))
          : 0;

        if (currentSlicesDone > lastSlicesDone) {
          lastSlicesDone = currentSlicesDone;
          onProgress?.(currentSlicesDone, totalSlices, Math.min(bytesReceived, totalBytes), totalBytes);
        }
      }
    }

    if (!headerReady || !growingBuffer || !hdr) {
      throw new Error("Truncated NIfTI file: header not found");
    }

    if (lastSlicesDone < totalSlices) {
      onProgress?.(totalSlices, totalSlices, totalBytes, totalBytes);
    }

    return { hdr, buffer: growingBuffer.buffer as unknown as ArrayBuffer };
  } finally {
    signal?.removeEventListener("abort", abortListener);
  }
}
