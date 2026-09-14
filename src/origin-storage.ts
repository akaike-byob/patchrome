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

// IndexedDB in Playwright's storageState file, so a file patchrome exports also loads in Playwright and back.
// A key or value that JSON cannot hold (a Date, bytes, a BigInt) goes in keyEncoded or valueEncoded, written in
// Playwright's evaluation serializer format.
export interface StorageStateIndexedDb {
  name: string;
  version: number;
  stores: Array<{
    name: string;
    autoIncrement: boolean;
    keyPath?: string | undefined;
    keyPathArray?: string[] | undefined;
    indexes: Array<{
      name: string;
      keyPath?: string | undefined;
      keyPathArray?: string[] | undefined;
      unique: boolean;
      multiEntry: boolean;
    }>;
    records: Array<{ key?: unknown; keyEncoded?: unknown; value?: unknown; valueEncoded?: unknown }>;
  }>;
}

export function toStorageStateIndexedDb(databases: IndexedDbDatabase[]): StorageStateIndexedDb[] {
  return databases.map((database) => ({
    name: database.name,
    version: database.version,
    stores: database.stores.map((store) => ({
      name: store.name,
      autoIncrement: store.autoIncrement,
      ...splitKeyPath(store.keyPath),
      indexes: store.indexes.map((index) => ({
        name: index.name,
        ...splitKeyPath(index.keyPath),
        unique: index.unique,
        multiEntry: index.multiEntry,
      })),
      // A store with a keyPath finds the key inside the value, so Playwright writes the value alone.
      records: store.records.map(({ key, value }) => ({
        ...(store.keyPath === null ? (isPlainJson(key) ? { key } : { keyEncoded: encodeValue(key) }) : {}),
        ...(isPlainJson(value) ? { value } : { valueEncoded: encodeValue(value) }),
      })),
    })),
  }));
}

export function fromStorageStateIndexedDb(databases: StorageStateIndexedDb[]): IndexedDbDatabase[] {
  return databases.map((database) => ({
    name: database.name,
    version: database.version,
    stores: database.stores.map((store) => ({
      name: store.name,
      keyPath: store.keyPathArray ?? store.keyPath ?? null,
      autoIncrement: store.autoIncrement,
      indexes: store.indexes.map((index) => ({
        name: index.name,
        keyPath: index.keyPathArray ?? index.keyPath ?? "",
        unique: index.unique,
        multiEntry: index.multiEntry,
      })),
      records: store.records.map((record) => ({
        // A stored null is plain JSON, so presence decides, not ??.
        key: "key" in record ? record.key : decodeValue(record.keyEncoded),
        value: "value" in record ? record.value : decodeValue(record.valueEncoded),
      })),
    })),
  }));
}

function splitKeyPath(keyPath: string | string[] | null): { keyPath?: string; keyPathArray?: string[] } {
  if (keyPath === null) return {};
  return typeof keyPath === "string" ? { keyPath } : { keyPathArray: keyPath };
}

// What JSON.stringify writes and JSON.parse reads back unchanged.
function isPlainJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, seen));
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) => isPlainJson(item, seen));
}

const typedArrayKinds = {
  i8: Int8Array,
  ui8: Uint8Array,
  ui8c: Uint8ClampedArray,
  i16: Int16Array,
  ui16: Uint16Array,
  i32: Int32Array,
  ui32: Uint32Array,
  f32: Float32Array,
  f64: Float64Array,
  bi64: BigInt64Array,
  bui64: BigUint64Array,
} as const;
type TypedArrayKind = keyof typeof typedArrayKinds;

function bytesToBase64(view: ArrayBufferView): string {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
}

function base64ToBuffer(base64: string): ArrayBuffer {
  return new Uint8Array(Buffer.from(base64, "base64")).buffer;
}

export function encodeValue(value: unknown, visited = new Map<object, number>(), ids = { last: 0 }): unknown {
  if (value === undefined || typeof value === "symbol" || typeof value === "function") return { v: "undefined" };
  if (value === null) return { v: "null" };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { v: "NaN" };
    if (value === Infinity) return { v: "Infinity" };
    if (value === -Infinity) return { v: "-Infinity" };
    if (Object.is(value, -0)) return { v: "-0" };
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return { bi: value.toString() };
  if (value instanceof Error) return { e: { n: value.name, m: value.message, s: value.stack ?? "" } };
  if (value instanceof Date) return { d: value.toJSON() };
  if (value instanceof URL) return { u: value.toJSON() };
  if (value instanceof RegExp) return { r: { p: value.source, f: value.flags } };
  // Buffer is a Uint8Array, so it lands on ui8 like any other byte array.
  for (const [kind, constructor] of Object.entries(typedArrayKinds)) {
    if (value instanceof constructor) return { ta: { b: bytesToBase64(value), k: kind } };
  }
  if (value instanceof ArrayBuffer) return { ab: { b: bytesToBase64(new Uint8Array(value)) } };
  const seenId = visited.get(value);
  if (seenId !== undefined) return { ref: seenId };
  const id = ++ids.last;
  visited.set(value, id);
  if (Array.isArray(value)) return { a: value.map((item) => encodeValue(item, visited, ids)), id };
  return {
    o: Object.entries(value).map(([k, item]) => ({ k, v: encodeValue(item, visited, ids) })),
    id,
  };
}

export function decodeValue(value: unknown, refs = new Map<number, unknown>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  const encoded = value as Record<string, unknown>;
  if ("ref" in encoded) return refs.get(encoded.ref as number);
  if ("v" in encoded) {
    switch (encoded.v) {
      case "null":
        return null;
      case "NaN":
        return NaN;
      case "Infinity":
        return Infinity;
      case "-Infinity":
        return -Infinity;
      case "-0":
        return -0;
      default:
        return undefined;
    }
  }
  if ("d" in encoded) return new Date(encoded.d as string);
  if ("u" in encoded) return new URL(encoded.u as string);
  if ("bi" in encoded) return BigInt(encoded.bi as string);
  if ("e" in encoded) {
    const { n, m, s } = encoded.e as { n: string; m: string; s: string };
    return Object.assign(new Error(m), { name: n, stack: s });
  }
  if ("r" in encoded) {
    const { p, f } = encoded.r as { p: string; f: string };
    return new RegExp(p, f);
  }
  if ("a" in encoded) {
    const items: unknown[] = [];
    refs.set(encoded.id as number, items);
    for (const item of encoded.a as unknown[]) items.push(decodeValue(item, refs));
    return items;
  }
  if ("o" in encoded) {
    const entries: Record<string, unknown> = {};
    refs.set(encoded.id as number, entries);
    for (const { k, v } of encoded.o as Array<{ k: string; v: unknown }>) {
      if (k !== "__proto__") entries[k] = decodeValue(v, refs);
    }
    return entries;
  }
  if ("ta" in encoded) {
    const { b, k } = encoded.ta as { b: string; k: string };
    if (!Object.hasOwn(typedArrayKinds, k)) throw new Error(`unknown typed array kind ${k} in IndexedDB record`);
    return new typedArrayKinds[k as TypedArrayKind](base64ToBuffer(b));
  }
  if ("ab" in encoded) return base64ToBuffer((encoded.ab as { b: string }).b);
  return value;
}
