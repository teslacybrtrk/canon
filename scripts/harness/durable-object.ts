// A Durable Object state for tests: SQL storage on node:sqlite (the same SQLite dialect), so the judge's real methods
// run against real tables. Two judges built on the same database are the same object after a restart.
import { DatabaseSync } from "node:sqlite";

export function sqlStorage(db: DatabaseSync) {
  return {
    exec(query: string, ...params: unknown[]) {
      const multi = query.trim().replace(/;\s*$/, "").includes(";");
      if (multi && params.length === 0) {
        db.exec(query);
        return cursor([]);
      }
      const stmt = db.prepare(query);
      const rows = /^\s*(select|with|pragma)/i.test(query) || /\breturning\b/i.test(query) ? (stmt.all(...(params as never[])) as Record<string, unknown>[]) : (stmt.run(...(params as never[])), []);
      return cursor(rows);
    },
  };
}

function cursor(rows: Record<string, unknown>[]) {
  return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
}

export function durableObjectState(db: DatabaseSync) {
  const kv = new Map<string, unknown>();
  return {
    storage: { sql: sqlStorage(db), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {}, kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => kv.set(k, v) } },
    id: { equals: () => true, toString: () => "test" },
    getWebSockets: () => [],
    waitUntil: (_p: Promise<unknown>) => {},
    blockConcurrencyWhile: <T>(f: () => Promise<T>) => f(),
  };
}
