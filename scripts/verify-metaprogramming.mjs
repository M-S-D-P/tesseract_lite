#!/usr/bin/env node
//
// Proves the claim the product rests on: that runtime observation identifies
// dynamically generated methods which reading the source cannot.
//
// It is a ground-truth test. The fixture below is written so the correct answer
// is known in advance, and the script fails loudly if the system disagrees:
//
//   total_due                      defined    (written in ledger.rb)
//   display_name                   defined    (written in tenant.rb)
//   block in <class:Ledger>        GENERATED  (a define_method loop in the model
//                                              file, as app/models/facility.rb
//                                              does in FMS; Ruby labels the frame
//                                              this way and no such def exists)
//   exclude_from_insurance_...     defined    (delegate — Rails attributes it to
//                                              the model file under its own name,
//                                              and the macro IS visible there, so
//                                              it must not be flagged)
//   index (ghost_controller.rb)    unknown    (file not indexed — the system must
//                                              refuse to judge it rather than call
//                                              it metaprogramming)
//
// The log below uses the frame labels Ruby 3.3 actually produces for each
// mechanism, measured rather than assumed, so this tests real Rails output.
//
// Usage — against a running instance:
//
//   node scripts/verify-metaprogramming.mjs \
//     --base http://localhost:3005 --email you@example.com --password '...'
//
// Options: --port <tcp port to bind for this test> (default 9711)
//          --keep (leave the fixture facet and source behind for inspection)
//
// Exits 0 on PASS, 1 on FAIL.

import net from "net";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const BASE = opt("base", "http://localhost:3005").replace(/\/$/, "");
const EMAIL = opt("email", process.env.VERIFY_EMAIL);
const PASSWORD = opt("password", process.env.VERIFY_PASSWORD);
const PORT = Number(opt("port", 9711));
const KEEP = args.includes("--keep");

if (!EMAIL || !PASSWORD) {
  console.error("Need --email and --password (an account on this instance).");
  process.exit(1);
}

// ---------------------------------------------------------------- fixture

const FILES = {
  "app/models/ledger.rb": `class Ledger < ApplicationRecord
  belongs_to :tenant
  has_many :line_items

  # Manufactured in a loop, exactly as app/models/facility.rb:1788 does in FMS.
  # Ruby records the block's location here, and labels the frame
  # "block in <class:Ledger>" — which is what the log will show.
  [:invoiceable, :subscription].each do |kind|
    define_method("paid_through_for_#{kind}") do
      ledger_delinquencies.where(exited_delinquency_at: nil).first
    end
  end

  # This one IS written here. Static analysis finds it.
  def total_due
    line_items.sum(:amount)
  end

  # Predicate and bang methods. A \\b boundary cannot match after ? or !, which
  # silently misreported every one of these as generated. Regression guard.
  def delinquent?
    ledger_delinquencies.exists?
  end

  def close!
    update!(closed_on: Date.today)
  end
end
`,
  "app/models/concerns/delinquency.rb": `module Delinquency
  extend ActiveSupport::Concern

  # Methods are manufactured here at load time. Nothing named
  # paid_through_for_invoiceable appears in ledger.rb, yet it will run.
  included do
    %w[invoiceable subscription].each do |kind|
      define_method("paid_through_for_#{kind}") do
        ledger_delinquencies.where(exited_delinquency_at: nil).first
      end
    end
  end
end
`,
  // Mirrors app/models/concerns/store_accessor_referenceable.rb in FMS: a macro
  // that manufactures a reader whose body evaluates a string path and queries.
  // Ruby labels the running frame "block in hstore_reference", so a naive check
  // finds "def hstore_reference" and wrongly calls it hand-written.
  "app/models/concerns/store_accessor_referenceable.rb": `module StoreAccessorReferenceable
  extend ActiveSupport::Concern

  module ClassMethods
    def hstore_reference(hstore_column, field, selector_code, options = {})
      define_method(field) do
        id = send("#{field}_id".to_sym)
        instance_eval(selector_code).where(id: id).first if id
      end
    end
  end
end
`,
  "app/models/tenant.rb": `class Tenant < ApplicationRecord
  has_many :ledgers
  has_one :settings

  # Rails passes the CALLER's file and line to module_eval, so a query issued
  # inside this forwarding method is attributed to this file under the
  # delegated method's own name. Static analysis can see the macro, so this
  # must NOT be reported as generated.
  # A multi-line delegate list — the name is not on the macro's own line.
  delegate :hyper?,
           :can_access_fms?,
           to: :role

  delegate :exclude_from_insurance_auto_enroll, to: :settings

  def display_name
    "#{first_name} #{last_name}"
  end
end
`,
};

// A real Rails log burst. Each query carries the "↳ file:line:in `method'"
// attribution line that makes this possible at all.
const LOG = `Creating scope :open. Overwriting existing method Lead.open.
Started GET "/company/2/ledgers/55" for 127.0.0.1 at 2026-01-01 06:00:00 +0000
Processing by LedgersController#show as HTML
  Ledger Load (1.2ms)  SELECT "ledgers".* FROM "ledgers" WHERE "ledgers"."id" = $1 LIMIT $2
  ↳ app/models/ledger.rb:8:in \`total_due'
  LineItem Sum (3.4ms)  SELECT SUM("line_items"."amount") FROM "line_items" WHERE "line_items"."ledger_id" = $1
  ↳ app/models/ledger.rb:9:in \`total_due'
  LedgerDelinquency Load (0.9ms)  SELECT "ledger_delinquencies".* FROM "ledger_delinquencies" WHERE "ledger_delinquencies"."exited_delinquency_at" IS NULL LIMIT $1
  ↳ app/models/ledger.rb:9:in \`block in <class:Ledger>'
  LedgerDelinquency Load (0.8ms)  SELECT "ledger_delinquencies".* FROM "ledger_delinquencies" WHERE "ledger_delinquencies"."exited_delinquency_at" IS NULL LIMIT $1
  ↳ app/models/ledger.rb:9:in \`block in <class:Ledger>'
  Setting Load (0.4ms)  SELECT "settings".* FROM "settings" WHERE "settings"."owner_id" = $1 LIMIT $2
  ↳ app/models/tenant.rb:8:in \`exclude_from_insurance_auto_enroll'
  FeeInvoiceableItem Load (1.4ms)  SELECT "invoiceable_items".* FROM "invoiceable_items" WHERE "invoiceable_items"."id" = $1 LIMIT $2
  ↳ app/models/concerns/store_accessor_referenceable.rb:8:in \`block in hstore_reference'
  Tenant Load (0.5ms)  SELECT "tenants".* FROM "tenants" WHERE "tenants"."id" = $1 LIMIT $2
  ↳ app/models/tenant.rb:11:in \`display_name'
  LedgerDelinquency Exists (0.3ms)  SELECT 1 AS one FROM "ledger_delinquencies" WHERE "ledger_delinquencies"."ledger_id" = $1 LIMIT $2
  ↳ app/models/ledger.rb:22:in \`delinquent?'
  Ledger Update (0.6ms)  UPDATE "ledgers" SET "closed_on" = $1 WHERE "ledgers"."id" = $2
  ↳ app/models/ledger.rb:26:in \`close!'
  Role Load (0.4ms)  SELECT "roles".* FROM "roles" WHERE "roles"."id" = $1 LIMIT $2
  ↳ app/models/tenant.rb:7:in \`can_access_fms?'
  Ghost Load (2.1ms)  SELECT "ghosts".* FROM "ghosts" WHERE "ghosts"."live" = $1
  ↳ app/controllers/ghost_controller.rb:9:in \`index'
Completed 200 OK in 88ms (Views: 40.0ms | ActiveRecord: 8.9ms)
`;

// An AppMap trace for the same fixture. The classMap carries each method's
// Method#source_location, which is the whole point: military_rank is generated
// by a macro and touches NO database, so it can never appear in a Rails log
// attribution line. Only instrumented call events reveal it.
const APPMAP = {
  version: "1.12",
  metadata: { name: "metaprog-fixture-trace", language: { name: "ruby" }, recorder: { name: "rspec" } },
  classMap: [
    {
      name: "app/models",
      type: "package",
      children: [
        {
          name: "Ledger",
          type: "class",
          children: [
            // Hand-written: located at its own def.
            { name: "total_due", type: "function", location: "app/models/ledger.rb:14", static: false },
            // Manufactured by the loop; Ruby locates it at the block.
            { name: "paid_through_for_invoiceable", type: "function", location: "app/models/ledger.rb:9", static: false },
          ],
        },
        {
          name: "Tenant",
          type: "class",
          children: [
            { name: "display_name", type: "function", location: "app/models/tenant.rb:16", static: false },
            // Generated by the macro, and it never queries anything.
            { name: "military_rank", type: "function", location: "app/models/concerns/store_accessor_referenceable.rb:6", static: false },
          ],
        },
      ],
    },
  ],
  events: [
    { event: "call", defined_class: "Tenant", method_id: "military_rank", path: "app/models/concerns/store_accessor_referenceable.rb", lineno: 6, elapsed: 0.0001 },
    { event: "call", defined_class: "Ledger", method_id: "total_due", path: "app/models/ledger.rb", lineno: 14, elapsed: 0.0004 },
  ],
};

// ------------------------------------------------------------------ helpers

let cookie = "";
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function streamLog(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.end(text);
    });
    socket.on("close", resolve);
    socket.on("error", reject);
  });
}

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? "[32mPASS[0m" : "[31mFAIL[0m"}  ${label}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  );
  return ok;
}

// --------------------------------------------------------------------- run

let facetId = null;
let sourceId = null;
let passed = false;

try {
  console.log(`\nVerifying metaprogramming detection against ${BASE}\n`);

  const login = await api("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: ${await login.text()}`);
  const who = await login.json();
  if (who.mustChangePassword) {
    throw new Error("that account must set its own password before it can be used here");
  }
  console.log(`Signed in as ${who.user.email} (${who.user.role})`);

  // 1. Index the fixture so there is a static side to compare against.
  const form = new FormData();
  for (const [path, body] of Object.entries(FILES)) {
    form.append("files", new Blob([body], { type: "text/plain" }), path.split("/").pop());
    form.append("paths", `metaprog-fixture/${path}`);
  }
  form.append(
    "files",
    new Blob([JSON.stringify(APPMAP)], { type: "application/json" }),
    "fixture.appmap.json"
  );
  form.append("paths", "metaprog-fixture/fixture.appmap.json");
  const created = await api("/api/resources", { method: "POST", body: form });
  if (!created.ok) throw new Error(`indexing failed: ${await created.text()}`);
  facetId = (await created.json()).id;
  console.log(`Indexing fixture facet ${facetId}…`);

  let ready = false;
  for (let i = 0; i < 60; i++) {
    const list = await api("/api/resources");
    const rows = list.ok ? (await list.json()).resources : [];
    const row = rows.find((r) => r.id === facetId);
    if (row?.status === "ready") { ready = true; break; }
    if (row?.status === "error") throw new Error(`indexing errored: ${row.error}`);
    await sleep(3000);
  }
  if (!ready) throw new Error("fixture did not finish indexing in time");
  console.log("Fixture indexed.");

  // 2. Connect a source and stream the log into it.
  const src = await api("/api/runtime/sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `metaprog-verify-${PORT}`,
      kind: "port",
      port: PORT,
      resource_id: facetId,
    }),
  });
  if (!src.ok) throw new Error(`could not bind port ${PORT}: ${await src.text()}`);
  sourceId = (await src.json()).id;
  await sleep(800);
  await streamLog(PORT, LOG);
  console.log(`Streamed the fixture log into port ${PORT}.`);
  await sleep(2500);

  // 3. Ask the system what it found, and hold it to the known answer.
  const res = await api("/api/runtime/metaprogramming");
  if (!res.ok) throw new Error(`report failed: ${await res.text()}`);
  const report = await res.json();

  // Assertions are about the FIXTURE, not about the whole instance: a real
  // deployment carries other traffic, and its findings are legitimate.
  const generated = report.generated.map((g) => `${g.method}@${g.file}`);
  const announced = report.announced.map((a) => `${a.kind}|${a.target}`);
  const fixtureGenerated = generated.filter((g) => g.endsWith("@app/models/ledger.rb"));

  console.log("\nGround truth:");
  const results = [
    check(
      "a define_method loop in the model file is reported as GENERATED " +
        "(frame 'block in <class:Ledger>' is no def in ledger.rb)",
      generated.includes("block in <class:Ledger>@app/models/ledger.rb"),
      true
    ),
    check(
      "a define_method body inside a macro is GENERATED, not mistaken for the macro's own def " +
        "(frame 'block in hstore_reference')",
      generated.includes("block in hstore_reference@app/models/concerns/store_accessor_referenceable.rb"),
      true
    ),
    check(
      "a delegated method is NOT called generated — the macro is visible statically",
      generated.includes("exclude_from_insurance_auto_enroll@app/models/tenant.rb"),
      false
    ),
    check(
      "total_due, which IS written in ledger.rb, is not called generated",
      fixtureGenerated.includes("total_due@app/models/ledger.rb"),
      false
    ),
    check(
      "display_name, which IS written in tenant.rb, is not called generated",
      generated.includes("display_name@app/models/tenant.rb"),
      false
    ),
    check(
      "a predicate method (def delinquent?) is NOT called generated",
      generated.includes("delinquent?@app/models/ledger.rb"),
      false
    ),
    check(
      "a bang method (def close!) is NOT called generated",
      generated.includes("close!@app/models/ledger.rb"),
      false
    ),
    check(
      "a name in a MULTI-LINE delegate list is NOT called generated",
      generated.includes("can_access_fms?@app/models/tenant.rb"),
      false
    ),
    check(
      "APPMAP: a generated method that issues NO SQL is found — impossible from a log",
      generated.includes("Tenant#military_rank@app/models/concerns/store_accessor_referenceable.rb"),
      true
    ),
    check(
      "APPMAP: a hand-written method located at its own def is NOT called generated",
      generated.includes("Ledger#total_due@app/models/ledger.rb"),
      false
    ),
    check(
      "an unindexed file is refused rather than called metaprogramming",
      report.unindexedFiles.includes("app/controllers/ghost_controller.rb"),
      true
    ),
    check(
      "the scope overwrite Rails announced is captured verbatim",
      announced.includes("scope :open|Lead.open"),
      true
    ),
  ];
  passed = results.every(Boolean);

  console.log(
    `\n  observed=${report.observedMethods} defined=${report.definedCount} ` +
      `generated=${report.generatedCount} unjudged=${report.unknownCount}` +
      `   (from AppMap: ${report.fromAppMap}, from the log: ${report.fromLog})`
  );
} catch (e) {
  console.error(`\n[31mERROR[0m ${e.message}`);
} finally {
  if (!KEEP) {
    if (sourceId) await api(`/api/runtime/sources/${sourceId}`, { method: "DELETE" });
    if (facetId) await api(`/api/resources/${facetId}`, { method: "DELETE" });
    console.log("Cleaned up the fixture facet and source.");
  }
}

console.log(
  passed
    ? "\n[32mPASS[0m — runtime observation identified a method that reading the source cannot.\n"
    : "\n[31mFAIL[0m\n"
);
process.exit(passed ? 0 : 1);
