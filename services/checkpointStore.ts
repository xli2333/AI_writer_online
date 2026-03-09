import { GenerationState, UploadedFile, WritingProjectData, WritingTaskOptions } from '../types';

const DB_NAME = 'writing-workspace-db';
const STORE_NAME = 'app-checkpoints';
const CHECKPOINT_KEY = 'active-checkpoint-v1';
const LOCAL_STORAGE_FALLBACK_KEY = 'WRITING_WORKSPACE_CHECKPOINT_V1';

export interface AppCheckpoint {
  version: 1;
  topic: string;
  taskOptions: WritingTaskOptions;
  uploadedFiles: UploadedFile[];
  projectData: WritingProjectData;
  genState: GenerationState;
  updatedAt: string;
}

const hasIndexedDb = () => typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

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
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open checkpoint database.'));
  });

const loadFromLocalStorage = (): AppCheckpoint | null => {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_FALLBACK_KEY);
    return raw ? (JSON.parse(raw) as AppCheckpoint) : null;
  } catch {
    return null;
  }
};

const saveToLocalStorage = (checkpoint: AppCheckpoint) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LOCAL_STORAGE_FALLBACK_KEY, JSON.stringify(checkpoint));
};

const clearFromLocalStorage = () => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(LOCAL_STORAGE_FALLBACK_KEY);
};

export const loadAppCheckpoint = async (): Promise<AppCheckpoint | null> => {
  try {
    const db = await openDb();

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(CHECKPOINT_KEY);

      request.onsuccess = () => resolve((request.result as AppCheckpoint | undefined) ?? null);
      request.onerror = () => reject(request.error || new Error('Failed to load checkpoint.'));
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error('Failed to load checkpoint.'));
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error || new Error('Failed to load checkpoint.'));
      };
    });
  } catch {
    return loadFromLocalStorage();
  }
};

export const saveAppCheckpoint = async (checkpoint: AppCheckpoint): Promise<void> => {
  try {
    const db = await openDb();

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const request = transaction.objectStore(STORE_NAME).put(checkpoint, CHECKPOINT_KEY);

      request.onerror = () => reject(request.error || new Error('Failed to save checkpoint.'));
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error('Failed to save checkpoint.'));
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error || new Error('Failed to save checkpoint.'));
      };
    });

    clearFromLocalStorage();
  } catch {
    saveToLocalStorage(checkpoint);
  }
};

export const clearAppCheckpoint = async (): Promise<void> => {
  try {
    const db = await openDb();

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const request = transaction.objectStore(STORE_NAME).delete(CHECKPOINT_KEY);

      request.onerror = () => reject(request.error || new Error('Failed to clear checkpoint.'));
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error('Failed to clear checkpoint.'));
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error || new Error('Failed to clear checkpoint.'));
      };
    });
  } catch {
    // Ignore IndexedDB cleanup failures and always clear the fallback storage.
  } finally {
    clearFromLocalStorage();
  }
};
