import { randomUUID } from 'node:crypto';

/** UTC timestamp stored in every row. SQLite never sees local time. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function newId(): string {
  return randomUUID();
}
