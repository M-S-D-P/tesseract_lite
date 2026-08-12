#!/usr/bin/env node
// Interactively create one account.
//
//   npm run create-account
//   npm run create-account -- --admin        (create an admin instead of a member)
//   npm run create-account -- --force-change (require a password change on first sign-in)
//
// Prompts for email and password, hashes the password the same way the app
// does (bcrypt, cost 10) and inserts the row directly into data/tesseract.db.
// Run this from the app directory (same place `npm run seed` runs from) so
// it finds the right database.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const ORG_NAME = process.env.SEED_ORG_NAME || "CubeSmart";
const MIN_LENGTH = 10; // matches src/app/api/auth/password/route.ts
const isAdmin = process.argv.includes("--admin");
const forceChange = process.argv.includes("--force-change");

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "tesseract.db");

const CTRL_C = 3;
const CTRL_D = 4;
const BACKSPACE = 8;
const DELETE = 127;

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("Not running in a terminal — can't prompt for a hidden password."));
      return;
    }
    process.stdout.write(question);
    let input = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    }
    let done = false;
    function onData(chunk) {
      // A chunk can contain more than one character — a pasted password
      // (e.g. from a password manager) arrives as a single event, not one
      // keystroke at a time.
      for (const char of chunk) {
        if (done) return;
        const code = char.charCodeAt(0);
        if (char === "\n" || char === "\r" || code === CTRL_D) {
          done = true;
          cleanup();
          process.stdout.write("\n");
          resolve(input);
        } else if (code === CTRL_C) {
          done = true;
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        } else if (code === BACKSPACE || code === DELETE) {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          input += char;
          process.stdout.write("*");
        }
      }
    }
    process.stdin.on("data", onData);
  });
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Run 'npm run seed' first.`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const orgs = db.prepare("SELECT id, name FROM orgs").all();
let org;
if (orgs.length === 0) {
  console.error(`No organization exists yet. Run 'npm run seed' first.`);
  process.exit(1);
} else if (orgs.length === 1) {
  org = orgs[0];
} else {
  org = orgs.find((o) => o.name === ORG_NAME);
  if (!org) {
    console.error(
      `Multiple organizations exist and none is named "${ORG_NAME}". ` +
        `Set SEED_ORG_NAME to pick one: ${orgs.map((o) => o.name).join(", ")}`
    );
    process.exit(1);
  }
}

const email = (await prompt("Email: ")).toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("That doesn't look like a valid email address.");
  process.exit(1);
}

const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
if (existing) {
  console.error(`An account already exists for ${email}. Use 'npm run reset-password' to change its password.`);
  process.exit(1);
}

const password = await promptHidden("Password (min 10 characters): ");
if (password.length < MIN_LENGTH) {
  console.error(`Password must be at least ${MIN_LENGTH} characters.`);
  process.exit(1);
}
const confirm = await promptHidden("Confirm password: ");
if (password !== confirm) {
  console.error("Passwords don't match.");
  process.exit(1);
}

const name = (await prompt("Name (optional): ")) || null;

const passwordHash = bcrypt.hashSync(password, 10);
db.prepare(
  `INSERT INTO users (id, org_id, email, name, password_hash, role, status, must_change_password)
   VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
).run(crypto.randomUUID(), org.id, email, name, passwordHash, isAdmin ? "admin" : "member", forceChange ? 1 : 0);

console.log(`\nCreated ${isAdmin ? "admin" : "member"} account: ${email}`);
if (forceChange) console.log("They must set a new password on first sign-in.");
db.close();
