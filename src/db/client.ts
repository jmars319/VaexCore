import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { initializeSchema } from "./schema";

export type DbClient = Database.Database;

export const createDbClient = (databaseUrl: string): DbClient => {
  const filePath = resolveDatabasePath(databaseUrl);
  mkdirSync(dirname(filePath), { recursive: true });

  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db);

  return db;
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
