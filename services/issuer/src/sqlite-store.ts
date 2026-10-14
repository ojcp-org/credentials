/** A durable `IssuerStore` on Node's built-in SQLite (Node 22.13+). */
import { DatabaseSync } from "node:sqlite";
import type { Collections, IssuerStore } from "./store.ts";

export class SqliteIssuerStore implements IssuerStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, id)) STRICT",
    );
  }

  async get<K extends keyof Collections>(kind: K, id: string): Promise<Collections[K] | undefined> {
    const row = this.#db
      .prepare("SELECT value FROM records WHERE kind = ? AND id = ?")
      .get(kind, id);
    return row ? (JSON.parse(String(row.value)) as Collections[K]) : undefined;
  }

  async put<K extends keyof Collections>(kind: K, value: Collections[K]): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO records (kind, id, value) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET value = excluded.value",
      )
      .run(kind, value.id, JSON.stringify(value));
  }

  async delete<K extends keyof Collections>(kind: K, id: string): Promise<void> {
    this.#db.prepare("DELETE FROM records WHERE kind = ? AND id = ?").run(kind, id);
  }

  async list<K extends keyof Collections>(
    kind: K,
    filter?: (value: Collections[K]) => boolean,
  ): Promise<Collections[K][]> {
    const rows = this.#db.prepare("SELECT value FROM records WHERE kind = ?").all(kind);
    const values = rows.map((row) => JSON.parse(String(row.value)) as Collections[K]);
    return filter ? values.filter(filter) : values;
  }

  close(): void {
    this.#db.close();
  }
}
