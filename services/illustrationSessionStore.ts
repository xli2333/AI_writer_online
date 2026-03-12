import type { ArticleIllustrationBundle } from '../types';

const DB_NAME = 'illustration-session-db';
const STORE_NAME = 'bundles';
const SESSION_ID_STORAGE_KEY = 'ILLUSTRATION_SESSION_ID_V1';
const STALE_RECORD_TTL_MS = 12 * 60 * 60 * 1000;

interface IllustrationSessionRecord {
  id: string;
  sessionId: string;
  bundleKey: string;
  bundle: ArticleIllustrationBundle;
  updatedAt: string;
}

const hasIndexedDb = () => typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

const cleanText = (value: string) => String(value || '').replace(/\r\n/g, '\n').trim();

const buildSessionBundleHash = (styleProfile: string, articleContent: string) => {
  const normalized = `${cleanText(styleProfile || 'fdsm').toLowerCase()}\n${cleanText(articleContent)}`;
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16);
};

const getSessionId = (createIfMissing = false) => {
  if (typeof window === 'undefined') return null;

  const existing = window.sessionStorage.getItem(SESSION_ID_STORAGE_KEY);
  if (existing) return existing;
  if (!createIfMissing) return null;

  const nextId =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `illustration-session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  window.sessionStorage.setItem(SESSION_ID_STORAGE_KEY, nextId);
  return nextId;
};

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error('IndexedDB is not available.'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open illustration session database.'));
  });

const withStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void
) => {
  const db = await openDb();

  return await new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);

    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error('Illustration session transaction failed.'));
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error || new Error('Illustration session transaction aborted.'));
    };
    transaction.oncomplete = () => {
      db.close();
    };

    run(store, resolve, reject);
  });
};

const pruneStaleRecords = async () => {
  if (!hasIndexedDb()) return;

  const cutoff = Date.now() - STALE_RECORD_TTL_MS;
  try {
    await withStore<void>('readwrite', (store, resolve, reject) => {
      const request = store.openCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }

        const record = cursor.value as IllustrationSessionRecord;
        const updatedAt = new Date(record.updatedAt || 0).getTime();
        if (!updatedAt || updatedAt < cutoff) {
          cursor.delete();
        }
        cursor.continue();
      };

      request.onerror = () => reject(request.error || new Error('Failed to prune illustration session records.'));
    });
  } catch {
    // Ignore cleanup failures. Session restore is best-effort only.
  }
};

export const computeIllustrationSessionBundleKey = (styleProfile: string, articleContent: string) => {
  const normalizedContent = cleanText(articleContent);
  if (!normalizedContent) return '';
  return `illustration-bundle:${buildSessionBundleHash(styleProfile, normalizedContent)}`;
};

export const loadIllustrationSessionBundle = async (bundleKey: string): Promise<ArticleIllustrationBundle | null> => {
  const normalizedKey = cleanText(bundleKey);
  const sessionId = getSessionId(false);
  if (!normalizedKey || !sessionId || !hasIndexedDb()) return null;

  try {
    const record = await withStore<IllustrationSessionRecord | null>('readonly', (store, resolve, reject) => {
      const request = store.get(`${sessionId}:${normalizedKey}`);
      request.onsuccess = () => resolve((request.result as IllustrationSessionRecord | undefined) || null);
      request.onerror = () => reject(request.error || new Error('Failed to load illustration session bundle.'));
    });
    void pruneStaleRecords();
    return record?.bundle || null;
  } catch {
    return null;
  }
};

export const saveIllustrationSessionBundle = async (bundleKey: string, bundle: ArticleIllustrationBundle): Promise<void> => {
  const normalizedKey = cleanText(bundleKey);
  const sessionId = getSessionId(true);
  if (!normalizedKey || !sessionId || !hasIndexedDb()) return;

  const record: IllustrationSessionRecord = {
    id: `${sessionId}:${normalizedKey}`,
    sessionId,
    bundleKey: normalizedKey,
    bundle,
    updatedAt: new Date().toISOString(),
  };

  try {
    await withStore<void>('readwrite', (store, resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('Failed to save illustration session bundle.'));
    });
    void pruneStaleRecords();
  } catch {
    // Ignore storage failures. The in-memory bundle remains usable in the current page session.
  }
};

export const clearIllustrationSessionBundle = async (bundleKey: string): Promise<void> => {
  const normalizedKey = cleanText(bundleKey);
  const sessionId = getSessionId(false);
  if (!normalizedKey || !sessionId || !hasIndexedDb()) return;

  try {
    await withStore<void>('readwrite', (store, resolve, reject) => {
      const request = store.delete(`${sessionId}:${normalizedKey}`);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('Failed to clear illustration session bundle.'));
    });
  } catch {
    // Ignore cleanup failures. This cache is session-only and best-effort.
  }
};
