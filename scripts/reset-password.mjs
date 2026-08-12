#!/usr/bin/env node
// Interactively reset an existing account's password.
//
//   npm run reset-password
//   npm run reset-password -- --force-change   (require a password change on next sign-in)
//
// Prompts for the account's email and a new password, hashes it the same way
// the app does (bcrypt, cost 10) and updates data/tesseract.db directly.
// Run this from the app directory (same place `npm run seed` runs from) so
// it finds the right database.

import fs from "fs";
import path from "path";
import readline from "readline";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const MIN_LENGTH = 10; // matches src/app/api/auth/password/route.ts
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
  console.error(`No database at ${DB_PATH}.`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const email = (await prompt("Email: ")).toLowerCase();
const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
if (!user) {
  console.error(`No account for ${email}.`);
  process.exit(1);
}

const password = await promptHidden("New password (min 10 characters): ");
if (password.length < MIN_LENGTH) {
  console.error(`Password must be at least ${MIN_LENGTH} characters.`);
  process.exit(1);
}
const confirm = await promptHidden("Confirm password: ");
if (password !== confirm) {
  console.error("Passwords don't match.");
  process.exit(1);
}

const passwordHash = bcrypt.hashSync(password, 10);
db.prepare("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?").run(
  passwordHash,
  forceChange ? 1 : 0,
  user.id
);

console.log(`\nPassword updated for ${email}.`);
if (forceChange) console.log("They must set a new password on next sign-in.");
db.close();
