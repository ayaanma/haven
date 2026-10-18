import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type SqlValue = SQLInputValue;
export type Row = Record<string, unknown>;

/**
 * Thin synchronous wrapper over Node's built-in `node:sqlite` (no native addon to
 * compile). Every query is parameterized; statements are cached per SQL string.
 * Feature agents use this handle directly for their own tables.
 */
export interface Db {
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[];
  /** Execute one or more statements without parameters (DDL, PRAGMA). */
  exec(sql: string): void;
  /**
   * Run `fn` inside a transaction. Nested calls join the outer transaction.
   * `fn` must be synchronous; do not await inside it.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly path: string;
}

export function openDatabase(filePath: string): Db {
  if (filePath !== ":memory:") mkdirSync(path.dirname(filePath), { recursive: true });
  const raw = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
  raw.exec("PRAGMA busy_timeout = 5000");
  if (filePath !== ":memory:") raw.exec("PRAGMA journal_mode = WAL");

  const cache = new Map<string, StatementSync>();
  const prepare = (sql: string) => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = raw.prepare(sql);
      cache.set(sql, statement);
    }
    return statement;
  };

  let depth = 0;

  return {
    path: filePath,
    run(sql, ...params) {
      const result = prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get<T extends Row>(sql: string, ...params: SqlValue[]) {
      return prepare(sql).get(...params) as T | undefined;
    },
    all<T extends Row>(sql: string, ...params: SqlValue[]) {
      return prepare(sql).all(...params) as T[];
    },
    exec(sql) {
      raw.exec(sql);
    },
    transaction(fn) {
      if (depth > 0) {
        depth++;
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      raw.exec("BEGIN IMMEDIATE");
      depth = 1;
      try {
        const result = fn();
        if (result instanceof Promise) {
          throw new Error("db.transaction callbacks must be synchronous");
        }
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      } finally {
        depth = 0;
      }
    },
    close() {
      cache.clear();
      raw.close();
    },
  };
}

/** Parse a JSON column, returning null for SQL NULL. */
export function parseJsonColumn<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return JSON.parse(String(value)) as T;
}
