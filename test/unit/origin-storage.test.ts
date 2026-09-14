import { describe, expect, it } from "vitest";
import {
  decodeValue,
  encodeValue,
  fromStorageStateIndexedDb,
  toStorageStateIndexedDb,
  type IndexedDbDatabase,
} from "../../src/origin-storage.ts";

const database: IndexedDbDatabase = {
  name: "auth",
  version: 3,
  stores: [
    {
      name: "users",
      keyPath: "id",
      autoIncrement: false,
      indexes: [{ name: "byEmail", keyPath: "email", unique: true, multiEntry: false }],
      records: [
        { key: "u1", value: { id: "u1", email: "ada@example.test" } },
        { key: "u2", value: { id: "u2", signedInAt: new Date(1700000000000), key: new Uint8Array([7, 8, 9]) } },
      ],
    },
    {
      name: "tokens",
      keyPath: null,
      autoIncrement: false,
      indexes: [{ name: "pair", keyPath: ["a", "b"], unique: false, multiEntry: false }],
      records: [
        { key: "firebase:authUser", value: "refresh-token" },
        { key: [1, new Date(0)], value: 12n },
      ],
    },
  ],
};

describe("IndexedDB in storageState files", () => {
  it("writes Playwright's shape: plain JSON as is, anything else encoded, keys only for stores without a keyPath", () => {
    const [written] = toStorageStateIndexedDb([database]);
    expect(written?.stores[0]).toEqual({
      name: "users",
      autoIncrement: false,
      keyPath: "id",
      indexes: [{ name: "byEmail", keyPath: "email", unique: true, multiEntry: false }],
      records: [
        { value: { id: "u1", email: "ada@example.test" } },
        {
          valueEncoded: {
            o: [
              { k: "id", v: "u2" },
              { k: "signedInAt", v: { d: "2023-11-14T22:13:20.000Z" } },
              { k: "key", v: { ta: { b: "BwgJ", k: "ui8" } } },
            ],
            id: 1,
          },
        },
      ],
    });
    expect(written?.stores[1]?.indexes[0]).toEqual({
      name: "pair",
      keyPathArray: ["a", "b"],
      unique: false,
      multiEntry: false,
    });
    expect(written?.stores[1]?.records[0]).toEqual({ key: "firebase:authUser", value: "refresh-token" });
    expect(written?.stores[1]?.records[1]).toEqual({
      keyEncoded: { a: [1, { d: "1970-01-01T00:00:00.000Z" }], id: 1 },
      valueEncoded: { bi: "12" },
    });
  });

  it("reads back what it wrote after a trip through JSON, leaving keys a keyPath finds in the value", () => {
    const file = JSON.parse(JSON.stringify(toStorageStateIndexedDb([database])));
    const [users, tokens] = database.stores;
    const withoutInlineKeys = {
      ...database,
      stores: [{ ...users, records: users?.records.map(({ value }) => ({ key: undefined, value })) }, tokens],
    };
    expect(fromStorageStateIndexedDb(file)).toEqual([withoutInlineKeys]);
  });

  it("keeps values JSON loses, and shared or circular references", () => {
    const shared = { n: 1 };
    const circular: Record<string, unknown> = { shared, again: shared };
    circular.self = circular;
    const values = [
      undefined,
      NaN,
      -Infinity,
      -0,
      new Float64Array([1.5, -2]),
      new Uint8Array([1, 2, 3]).buffer,
      /a+b/gi,
      Object.assign(new Error("boom"), { name: "TypeError" }),
    ];
    const decoded = decodeValue(JSON.parse(JSON.stringify(encodeValue(values)))) as unknown[];
    expect(decoded.slice(0, 6)).toEqual(values.slice(0, 6));
    expect(Object.is(decoded[3], -0)).toBe(true);
    expect(decoded[6]).toEqual(/a+b/gi);
    expect(decoded[7]).toMatchObject({ name: "TypeError", message: "boom" });

    const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(circular)))) as Record<string, unknown>;
    expect(back.self).toBe(back);
    expect(back.again).toBe(back.shared);
  });

  it("refuses a typed array kind it does not know", () => {
    expect(() => decodeValue({ ta: { b: "", k: "f16" } })).toThrow("unknown typed array kind f16");
  });
});
