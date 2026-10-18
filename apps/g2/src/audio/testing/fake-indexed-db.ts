/** Minimal asynchronous IndexedDB test double; records survive new journal/service instances. */
export function fakeAudioIndexedDB() {
  const values = new Map<IDBValidKey, unknown>();
  let blockWrites = false;
  const waiting: (() => void)[] = [];
  const persist = (callback: () => void) => {
    if (blockWrites) waiting.push(callback);
    else queueMicrotask(callback);
  };
  const database = {
    createObjectStore() {},
    transaction() {
      const transaction: {
        oncomplete?: () => void;
        objectStore(): unknown;
      } = {
        objectStore: () => ({
          put(value: unknown, key: IDBValidKey) {
            const copy = structuredClone(value);
            persist(() => {
              values.set(key, copy);
              transaction.oncomplete?.();
            });
          },
          delete(key: IDBValidKey) {
            persist(() => {
              values.delete(key);
              transaction.oncomplete?.();
            });
          },
          get(key: IDBValidKey) {
            const request: { result?: unknown; onsuccess?: () => void } = {};
            queueMicrotask(() => {
              request.result = structuredClone(values.get(key));
              request.onsuccess?.();
            });
            return request;
          },
        }),
      };
      return transaction;
    },
  };
  return {
    factory: {
      open() {
        const request: { result: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = {
          result: database,
        };
        queueMicrotask(() => {
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    } as unknown as IDBFactory,
    block() {
      blockWrites = true;
    },
    unblock() {
      blockWrites = false;
      for (const callback of waiting.splice(0)) queueMicrotask(callback);
    },
  };
}
