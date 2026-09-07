import fs from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * In-process D1 shim backed by node:sqlite.
 *
 * Accepts an ordered list of absolute schema file paths; executes each in sequence so tests are
 * explicit about their schema surface. There is no default — every caller must name its files.
 *
 * Boolean values are transparently mapped to integers on `bind()` to match D1 wire behaviour.
 * Foreign keys are enabled and WAL mode is active so FK constraint tests work identically to
 * production.
 *
 * @summary Reusable in-process D1 database shim backed by node:sqlite for schema and
 * integration tests
 */

// ---------------------------------------------------------------------------
// Minimal local D1 type surface — avoids depending on @cloudflare/workers-types
// in a Node-only test-utils package.
// ---------------------------------------------------------------------------

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: { changes?: number; last_row_id?: number | bigint; duration?: number };
}

interface D1ExecResult {
  count: number;
  duration: number;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  dump(): Promise<ArrayBuffer>;
  exec(query: string): Promise<D1ExecResult>;
}

class D1PreparedStatementImpl {
  private boundValues: SQLInputValue[] = [];

  constructor(
    private db: DatabaseSync,
    private sql: string
  ) {}

  bind(...values: unknown[]): D1PreparedStatementImpl {
    // D1 transparently converts booleans to integers; node:sqlite does not
    this.boundValues = values.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)) as SQLInputValue[];
    return this;
  }

  async first<T>(column?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const result = stmt.get(...this.boundValues) as Record<string, unknown> | undefined;
    if (!result) return null;
    if (column) return (result[column] ?? null) as T;
    return result as T;
  }

  async run(): Promise<D1Result> {
    const stmt = this.db.prepare(this.sql);
    const { changes, lastInsertRowid } = stmt.run(...this.boundValues);
    return { success: true, meta: { changes: changes as number, last_row_id: Number(lastInsertRowid) } };
  }

  async all<T>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...this.boundValues) as T[];
    return { results, success: true };
  }

  runSync(): D1Result {
    const stmt = this.db.prepare(this.sql);
    const { changes, lastInsertRowid } = stmt.run(...this.boundValues);
    return { success: true, meta: { changes: changes as number, last_row_id: Number(lastInsertRowid) } };
  }
}

export interface TestD1DatabaseOptions {
  /** Ordered list of absolute paths to SQL schema files. All files are read and exec'd in order. */
  schemaFiles: readonly string[];
}

/**
 * In-process D1 shim for use in tests.
 *
 * @example
 * ```ts
 * const db = new TestD1Database({ schemaFiles: [resolve(__dirname, '../schema.sql')] });
 * const result = await db.getDb().prepare('SELECT 1').first();
 * db.close();
 * ```
 */
export class TestD1Database {
  private db: DatabaseSync;
  private d1: D1Database;

  constructor(options: TestD1DatabaseOptions) {
    this.db = new DatabaseSync(':memory:');

    // Enable WAL mode and foreign keys for SQLite
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    // Read each schema file in order and execute
    const sql = options.schemaFiles.map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
    this.db.exec(sql);

    this.d1 = this.createD1Wrapper();
  }

  private createD1Wrapper(): D1Database {
    const db = this.db;

    return {
      prepare(query: string): D1PreparedStatement {
        return new D1PreparedStatementImpl(db, query) as unknown as D1PreparedStatement;
      },

      async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
        db.exec('BEGIN');
        try {
          const results = statements.map((stmt) => {
            const impl = stmt as unknown as D1PreparedStatementImpl;
            return impl.runSync();
          });
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },

      async dump(): Promise<ArrayBuffer> {
        throw new Error('dump() is not supported in TestD1Database');
      },

      async exec(query: string): Promise<D1ExecResult> {
        db.exec(query);
        return { count: 1, duration: 0 };
      }
    } as D1Database;
  }

  getDb(): D1Database {
    return this.d1;
  }

  close(): void {
    this.db.close();
  }

  getRawDb(): DatabaseSync {
    return this.db;
  }
}
