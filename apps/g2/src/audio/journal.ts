/** IndexedDB checkpoints contain only this recording's unacknowledged audio. No tokens. */
export interface AudioCheckpoint {
  alertId: string;
  recordingId: string;
  startedAtMs: number;
  totalBytes: number;
  nextIndex: number;
  uploadedChunks: number;
  chunks: { index: number; bytes: Uint8Array }[];
  tail: Uint8Array;
}

export function createAudioJournal() {
  let database: Promise<IDBDatabase> | undefined;
  let writes: Promise<void> | null = null;
  let pending: {
    value: AudioCheckpoint | null;
    listeners: { resolve(): void; reject(error: unknown): void }[];
  } | null = null;
  function open() {
    if (!globalThis.indexedDB) return null;
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("haven-emergency-audio-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("pending");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Audio checkpoint storage unavailable"));
    });
    return database;
  }
  async function write(value: AudioCheckpoint | null) {
    const db = await open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("pending", "readwrite");
      const store = transaction.objectStore("pending");
      if (value) store.put(value, "active");
      else store.delete("active");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("Audio checkpoint could not be saved"));
      transaction.onabort = transaction.onerror;
    });
  }
  async function drain() {
    while (pending) {
      const batch = pending;
      pending = null;
      try {
        await write(batch.value);
        for (const listener of batch.listeners) listener.resolve();
      } catch (error) {
        for (const listener of batch.listeners) listener.reject(error);
      }
    }
    writes = null;
  }
  return {
    save(value: AudioCheckpoint | null): Promise<void> {
      // Serialize snapshots so an older write cannot resurrect acknowledged audio.
      const copy = value ? structuredClone(value) : null;
      return new Promise<void>((resolve, reject) => {
        if (pending) {
          pending.value = copy;
          pending.listeners.push({ resolve, reject });
        } else pending = { value: copy, listeners: [{ resolve, reject }] };
        writes ??= drain();
      });
    },
    async load(): Promise<AudioCheckpoint | null> {
      await writes?.catch(() => {});
      const db = await open();
      if (!db) return null;
      return new Promise((resolve, reject) => {
        const request = db.transaction("pending", "readonly").objectStore("pending").get("active");
        request.onsuccess = () => resolve((request.result as AudioCheckpoint | undefined) ?? null);
        request.onerror = () => reject(new Error("Audio checkpoint could not be read"));
      });
    },
  };
}
