// JSON file store: users, passkeys, daily spend. Fine for a demo; swap for Cloud SQL later.
//
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), "../data/store.json");

export interface StoredUser {
  id: string;
  googleSub: string;
  email: string;
  name: string;
  picture?: string;
  spentCentsToday: number;
  spendDay: string;
}

export interface StoredPasskey {
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}

interface Db {
  users: StoredUser[];
  passkeys: StoredPasskey[];
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function load(): Db {
  try {
    return JSON.parse(readFileSync(DATA_PATH, "utf8")) as Db;
  } catch {
    return { users: [], passkeys: [] };
  }
}

function save(db: Db): void {
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(db, null, 2));
}

export function findUserByGoogleSub(sub: string): StoredUser | undefined {
  return load().users.find((u) => u.googleSub === sub);
}

export function findUserById(id: string): StoredUser | undefined {
  return load().users.find((u) => u.id === id);
}

export function upsertGoogleUser(input: {
  googleSub: string;
  email: string;
  name: string;
  picture?: string;
}): StoredUser {
  const db = load();
  let user = db.users.find((u) => u.googleSub === input.googleSub);
  if (!user) {
    user = {
      id: randomUUID(),
      googleSub: input.googleSub,
      email: input.email,
      name: input.name,
      picture: input.picture,
      spentCentsToday: 0,
      spendDay: todayUtc(),
    };
    db.users.push(user);
  } else {
    user.email = input.email;
    user.name = input.name;
    user.picture = input.picture;
  }
  save(db);
  return user;
}

export function passkeysForUser(userId: string): StoredPasskey[] {
  return load().passkeys.filter((p) => p.userId === userId);
}

export function savePasskey(passkey: StoredPasskey): void {
  const db = load();
  const idx = db.passkeys.findIndex((p) => p.credentialId === passkey.credentialId);
  if (idx >= 0) db.passkeys[idx] = passkey;
  else db.passkeys.push(passkey);
  save(db);
}

export function findPasskey(credentialId: string): StoredPasskey | undefined {
  return load().passkeys.find((p) => p.credentialId === credentialId);
}

export function resetSpendIfNewDay(user: StoredUser): StoredUser {
  const day = todayUtc();
  if (user.spendDay === day) return user;
  const db = load();
  const row = db.users.find((u) => u.id === user.id);
  if (!row) return user;
  row.spendDay = day;
  row.spentCentsToday = 0;
  save(db);
  return row;
}

export function canSpend(userId: string, cents: number, cap: number): { ok: true } | { ok: false; reason: string } {
  const db = load();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return { ok: false, reason: "Unknown user." };
  resetSpendIfNewDay(user);
  const fresh = db.users.find((u) => u.id === userId)!;
  if (fresh.spentCentsToday + cents > cap) {
    return { ok: false, reason: `Daily try limit reached (${cap}¢ per day). Come back tomorrow.` };
  }
  return { ok: true };
}

export function recordSpend(userId: string, cents: number): void {
  const db = load();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return;
  resetSpendIfNewDay(user);
  user.spentCentsToday += cents;
  save(db);
}