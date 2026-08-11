#!/usr/bin/env node
// Seeds the CubeSmart organization and its accounts.
//
//   npm run seed
//
// Idempotent: re-running adds only what is missing and never touches an
// existing user's password. Every new account starts on one shared password
// (see SEED_PASSWORD below) and must replace it on first sign-in.
//
// Safe to run before the app has ever started: the tables it needs are
// created here with the same definitions the app uses (CREATE TABLE IF NOT
// EXISTS), and the app creates the rest on boot.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const ORG_NAME = process.env.SEED_ORG_NAME || "CubeSmart";

// The operator account. Sees Admin, Pipeline and Tuning — model choice,
// embedding provider, connectors, users.
const ADMIN = {
  email: process.env.SEED_ADMIN_EMAIL || "smallela@cubesmart.com",
  name: "Sandeep Mallela",
};

// Everyone else: chat and facets only.
const MEMBERS = [
  "RKeeley@cubesmart.com",
  "rtrivedi@cubesmart.com",
  "KJagtap@cubesmart.com",
  "HChu@cubesmart.com",
  "SSabapathi@cubesmart.com",
  "JMahmood@cubesmart.com",
  "CMeyers@cubesmart.com",
  "JHoffman@cubesmart.com",
  "SKrishna@cubesmart.com",
  "DSharma@cubesmart.com",
  "NPatil@cubesmart.com",
  "MZambre@cubesmart.com",
  "LNawab@cubesmart.com",
  "RSawant@cubesmart.com",
  "SPanhalkar@cubesmart.com",
];

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "tesseract.db");
const CREDS_PATH = path.join(DATA_DIR, "seed-credentials.txt");

// One shared starting password for every seeded account, so rollout is a
// single sentence to fifteen people instead of fifteen separate handovers.
// Every account must replace it on first sign-in, which is what keeps a
// shared, guessable starter acceptable — until then the account can do
// nothing else.
//
// Override with SEED_PASSWORD. Set SEED_FORCE_PASSWORD_CHANGE=false to skip
// the forced change (not recommended: the password is in this file, and
// therefore in the repository).
const SEED_PASSWORD = process.env.SEED_PASSWORD || "cs2026x";
const FORCE_CHANGE = process.env.SEED_FORCE_PASSWORD_CHANGE !== "false";

function nameFromEmail(email) {
  // "RKeeley@cubesmart.com" → "R Keeley"; best-effort, editable in Admin.
  // All-lowercase locals ("rtrivedi") have no boundary to split on and just
  // get capitalised.
  const local = email.split("@")[0];
  const split = local
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^([A-Z])([A-Z][a-z])/, "$1 $2");
  return split.charAt(0).toUpperCase() + split.slice(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Mirrors src/lib/db.ts. The app creates every other table on first boot.
db.exec(`
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'self-hosted',
  seats INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  auth_provider TEXT NOT NULL DEFAULT 'password',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
for (const stmt of [
  "ALTER TABLE users ADD COLUMN org_id TEXT",
  "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
]) {
  try {
    db.exec(stmt);
  } catch {
    // already present
  }
}

let org = db.prepare("SELECT id, name FROM orgs WHERE name = ?").get(ORG_NAME);
if (!org) {
  // Adopt an existing single org rather than stranding its data beside a new one.
  const existing = db.prepare("SELECT id, name FROM orgs LIMIT 2").all();
  if (existing.length === 1) {
    db.prepare("UPDATE orgs SET name = ? WHERE id = ?").run(ORG_NAME, existing[0].id);
    org = { id: existing[0].id, name: ORG_NAME };
    console.log(`Renamed existing organization "${existing[0].name}" → "${ORG_NAME}"`);
  } else {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run(id, ORG_NAME);
    org = { id, name: ORG_NAME };
    console.log(`Created organization "${ORG_NAME}"`);
  }
} else {
  console.log(`Organization "${ORG_NAME}" already exists`);
}

const findUser = db.prepare("SELECT id, role FROM users WHERE email = ?");
// must_change_password: the starting password is shared and lives in this
// file, so the owner is made to replace it before the account can be used.
const insertUser = db.prepare(
  `INSERT INTO users (id, org_id, email, name, password_hash, role, status, must_change_password)
   VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
);
const promote = db.prepare("UPDATE users SET role = 'admin', org_id = ? WHERE id = ?");

// Hashed once — bcrypt on sixteen accounts is otherwise the slowest part.
const passwordHash = bcrypt.hashSync(SEED_PASSWORD, 10);

const created = [];
let skipped = 0;

function ensureUser(email, role) {
  const existing = findUser.get(email);
  if (existing) {
    if (role === "admin" && existing.role !== "admin") {
      promote.run(org.id, existing.id);
      console.log(`Promoted existing account to admin: ${email}`);
    } else {
      skipped += 1;
    }
    return;
  }
  insertUser.run(
    crypto.randomUUID(),
    org.id,
    email,
    role === "admin" ? ADMIN.name : nameFromEmail(email),
    passwordHash,
    role,
    FORCE_CHANGE ? 1 : 0
  );
  created.push({ email, role });
}

ensureUser(ADMIN.email, "admin");
for (const email of MEMBERS) ensureUser(email, "member");

if (created.length > 0) {
  const lines = [
    `Tesseract Lite — seeded accounts for ${ORG_NAME}`,
    `Generated ${new Date().toISOString()}`,
    "",
    `Starting password for every account below: ${SEED_PASSWORD}`,
    FORCE_CHANGE
      ? "Each account must choose its own password on first sign-in."
      : "WARNING: the forced password change is disabled for this seed.",
    "",
    ...created.map((u) => `${u.role.padEnd(6)}  ${u.email}`),
    "",
  ];
  fs.writeFileSync(CREDS_PATH, lines.join("\n"), { mode: 0o600 });
  console.log(`\n${lines.join("\n")}`);
  console.log(`Written to ${CREDS_PATH} (mode 0600).`);
}

console.log(
  `\nDone — ${created.length} account(s) created, ${skipped} already existed.` +
    `\nAdmin: ${ADMIN.email}  ·  Members: ${MEMBERS.length}`
);
db.close();
