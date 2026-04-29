import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { initializeSchema } from "./schema";

type RunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

type DbStatement = {
  run: (...params: unknown[]) => RunResult;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

export type DbClient = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => DbStatement;
  pragma?: (source: string) => unknown;
  close: () => unknown;
};

const require = createRequire(import.meta.url);

export const createDbClient = (databaseUrl: string): DbClient => {
  const filePath = resolveDatabasePath(databaseUrl);
  mkdirSync(dirname(filePath), { recursive: true });

  const db = openDatabase(filePath);
  enablePragmas(db);
  initializeSchema(db);

  return db;
};

const openDatabase = (filePath: string): DbClient => {
  try {
    const Database = require("better-sqlite3") as {
      new (path: string): DbClient;
    };
    return new Database(filePath);
  } catch (error) {
    if (!canFallbackToNodeSqlite(error)) {
      throw error;
    }

    const sqlite = require("node:sqlite") as {
      DatabaseSync: new (path: string) => DbClient;
    };
    return new sqlite.DatabaseSync(filePath);
  }
};

const enablePragmas = (db: DbClient) => {
  if (db.pragma) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return;
  }

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
};

const canFallbackToNodeSqlite = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("NODE_MODULE_VERSION") || message.includes("better_sqlite3.node");
};

const resolveDatabasePath = (databaseUrl: string) => {
  if (databaseUrl === ":memory:") {
    return databaseUrl;
  }

  if (databaseUrl.startsWith("file:")) {
    return resolve(process.cwd(), databaseUrl.slice("file:".length));
  }

  return resolve(process.cwd(), databaseUrl);
};
