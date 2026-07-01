import Database from "better-sqlite3";

import { runSchemaMigrations } from "./migration-runner.js";

export interface DatabaseClient {
  connection: Database.Database;
  close(): void;
}

export function openDatabase(path: string): DatabaseClient {
  const connection = new Database(path);
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  runSchemaMigrations(connection);

  return {
    connection,
    close() {
      connection.close();
    }
  };
}
