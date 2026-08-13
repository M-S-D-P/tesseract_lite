#!/usr/bin/env node
// Replays a REAL Rails log file as if it were streaming live.
//
// This is the highest-fidelity demo input: it is genuinely your application's
// traffic, just time-shifted. Copy a log out of VDI (a text file, far easier
// than a database dump) and point this at it.
//
//   node scripts/replay-rails-log.mjs log/development.log | nc localhost 9999
//   node scripts/replay-rails-log.mjs fms.log --speed 4 --loop | nc localhost 9999
//
// Pacing follows the "Started ... at <timestamp>" lines when present, so the
// replay has the same rhythm as the original — bursts and idle gaps included.

import fs from "fs";
import readline from "readline";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const SPEED = Number(opt("speed", 1)) || 1; // >1 = faster than real time
const LOOP = args.includes("--loop");
const MAX_GAP = Number(opt("max-gap", 3000)); // never idle longer than this

if (!file || !fs.existsSync(file)) {
  console.error("usage: replay-rails-log.mjs <logfile> [--speed N] [--loop] [--max-gap MS]");
  process.exit(1);
}

const STARTED = /^Started\s+\w+\s+"[^"]+"\s+for\s+\S+\s+at\s+(.+)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function replayOnce(pass) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  let prevStamp = null;
  let count = 0;

  for await (const line of rl) {
    const m = line.match(STARTED);
    if (m) {
      const stamp = Date.parse(m[1].replace(/\s([+-]\d{4})$/, " GMT$1"));
      if (!Number.isNaN(stamp)) {
        if (prevStamp !== null) {
          const gap = Math.min(MAX_GAP, Math.max(0, (stamp - prevStamp) / SPEED));
          if (gap > 0) await sleep(gap);
        }
        prevStamp = stamp;
      }
      count++;
    }
    process.stdout.write(line + "\n");
  }
  console.error(`[replay] pass ${pass}: ${count} requests streamed from ${file}`);
}

let pass = 1;
do {
  await replayOnce(pass++);
  if (LOOP) await sleep(1500);
} while (LOOP);
