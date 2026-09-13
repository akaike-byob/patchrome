// localStorage and IndexedDB for one origin, in a shape Playwright's evaluate carries both ways. Dates,
// typed arrays, ArrayBuffers and BigInts survive the trip; Blobs, Maps and Sets do not.

export interface IndexedDbIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

export interface IndexedDbStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexedDbIndex[];
  records: Array<{ key: unknown; value: unknown }>;
}

export interface IndexedDbDatabase {
  name: string;
  version: number;
  stores: IndexedDbStore[];
}

export interface OriginStorage {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
  indexedDB: IndexedDbDatabase[];
}

// Runs in the page, so it may only use what the page has.
export async function readOriginStorageInPage(): Promise<Omit<OriginStorage, "origin">> {
  const settle = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const databases: IndexedDbDatabase[] = [];
  for (const info of await indexedDB.databases()) {
    if (info.name === undefined) continue;
    const db = await settle(indexedDB.open(info.name));
    try {
      const stores: IndexedDbStore[] = [];
      for (const storeName of db.objectStoreNames) {
        const store = db.transaction(storeName, "readonly").objectStore(storeName);
        const [keys, values] = await Promise.all([settle(store.getAllKeys()), settle(store.getAll())]);
        stores.push({
          name: storeName,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: [...store.indexNames].map((indexName) => {
            const index = store.index(indexName);
            return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
          }),
          records: keys.map((key, position) => ({ key, value: values[position] })),
        });
      }
      databases.push({ name: info.name, version: db.version, stores });
    } finally {
      db.close();
    }
  }
  return { localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })), indexedDB: databases };
}

// localStorage items are added next to what the origin has. Each IndexedDB database is replaced whole:
// merging records into a schema of another version would leave the site's data half upgraded.
export async function writeOriginStorageInPage(storage: Omit<OriginStorage, "origin">): Promise<void> {
  const settle = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  for (const { name, value } of storage.localStorage) localStorage.setItem(name, value);
  for (const database of storage.indexedDB) {
    await settle(indexedDB.deleteDatabase(database.name));
    const opening = indexedDB.open(database.name, database.version);
    opening.onupgradeneeded = () => {
      for (const store of database.stores) {
        const created = opening.result.createObjectStore(store.name, {
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
        });
        for (const index of store.indexes)
          created.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
      }
    };
    const db = await settle(opening);
    try {
      for (const store of database.stores) {
        const transaction = db.transaction(store.name, "readwrite");
        const objectStore = transaction.objectStore(store.name);
        for (const { key, value } of store.records) {
          if (store.keyPath === null) objectStore.put(value, key as IDBValidKey);
          else objectStore.put(value);
        }
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      }
    } finally {
      db.close();
    }
  }
}
