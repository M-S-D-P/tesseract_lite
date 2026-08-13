#!/usr/bin/env node
// Emits Rails log output in the EXACT format the CubeSmart FMS app produces —
// same controllers, tables, source-attribution lines, cache markers and
// failure modes as the real captured log.
//
//   node scripts/simulate-rails-log.mjs | nc localhost 9999          # Discourse (default)
//   node scripts/simulate-rails-log.mjs --app fms | nc localhost 9999 # FMS-shaped
//   node scripts/simulate-rails-log.mjs --rate 900          # slower, readable
//   node scripts/simulate-rails-log.mjs --once              # one of each scenario
//
// Modelled on FMS: Rails 5.2 / Ruby 2.6, verbose_query_logs on (the "↳" lines),
// Flipper feature gates, hstore settings, CanCan abilities, Devise sessions.

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const RATE = Number(opt("rate", 700));
const ONCE = args.includes("--once");

const FACILITY_UUID = "3307c114-b0f8-402c-8956-0cb6c78f74eb";
const USER_ID = 129380;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ms = (lo, hi) => (lo + Math.random() * (hi - lo)).toFixed(1);
const id = () => Math.floor(1000000 + Math.random() * 9000000);
const out = (s) => process.stdout.write(s + "\n");

// "  User Load (1.4ms)  SELECT ..." followed by "  ↳ app/models/user.rb:289:in `x'"
const sql = (label, dur, statement, source) => {
  out(`  ${label} (${dur}ms)  ${statement}`);
  if (source) out(`  ↳ ${source}`);
};
const cached = (label, statement, source) => {
  out(`  CACHE ${label} (0.0ms)  ${statement}`);
  if (source) out(`  ↳ ${source}`);
};

function started(method, path) {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")} ${d.toTimeString().slice(0, 8)} -0400`;
  out(`Started ${method} "${path}" for 127.0.0.1 at ${stamp}`);
}
function processing(controller, action, format = "HTML") {
  out(`Processing by ${controller}#${action} as ${format}`);
}
function completed(status, total, views, db) {
  const label =
    { 200: "OK", 201: "Created", 302: "Found", 401: "Unauthorized", 404: "Not Found", 422: "Unprocessable Entity", 500: "Internal Server Error" }[status] ?? "";
  const parts = [];
  if (views !== null) parts.push(`Views: ${views}ms`);
  parts.push(`ActiveRecord: ${db}ms`);
  parts.push(`Allocations: ${Math.floor(total * 320)}`);
  out(`Completed ${status} ${label} in ${Math.round(total)}ms (${parts.join(" | ")})`);
  out("");
}

// Rails announces metaprogramming as it happens — the real log is full of these.
const SCOPES = [
  ["turned_on", "ApiAssociation.turned_on"],
  ["print", "EventDocument.print"],
  ["print", "Template.print"],
  ["open", "Lead.open"],
  ["reformed", "Facility.reformed"],
  ["cubesmart_active", "Facility.cubesmart_active"],
  ["with_acs_registration", "Ledger.with_acs_registration"],
  ["ready_for_processing", "AutopayEventBatch.ready_for_processing"],
];
const maybeScope = () => {
  if (Math.random() < 0.25) {
    const [scope, target] = pick(SCOPES);
    out(`Creating scope :${scope}. Overwriting existing method ${target}.`);
  }
};

// Boilerplate every authenticated FMS request performs.
function authPreamble(facilityId) {
  sql("User Load", ms(0.9, 2.4), `SELECT "users".* FROM "users" WHERE "users"."id" = $1 ORDER BY "users"."id" ASC LIMIT $2  [["id", ${USER_ID}], ["LIMIT", 1]]`, "app/controllers/application_controller.rb:206:in `current_facility'");
  sql("Company Load", ms(1.0, 1.9), `SELECT "companies".* FROM "companies" WHERE "companies"."id" = $1 LIMIT $2  [["id", 1], ["LIMIT", 1]]`, "app/models/user.rb:244:in `timeout_in'");
  sql("CompanySettings Load", ms(1.1, 2.3), `SELECT "settings".* FROM "settings" WHERE "settings"."owner_type" = $1 AND "settings"."owner_id" = $2 LIMIT $3  [["owner_type", "Company"], ["owner_id", 1], ["LIMIT", 1]]`, "app/models/user.rb:244:in `timeout_in'");
  sql("Role Load", ms(1.1, 2.5), `SELECT "roles".* FROM "roles" WHERE "roles"."id" = $1 LIMIT $2  [["id", 2], ["LIMIT", 1]]`, "app/models/user.rb:65:in `hyper?'");
  cached("Company Load", `SELECT "companies".* FROM "companies" WHERE "companies"."id" = $1 LIMIT $2  [["id", 1], ["LIMIT", 1]]`, "app/models/role.rb:69:in `hyper?'");
  sql("Facility Load", ms(1.0, 1.7), `SELECT "facilities".* FROM "facilities" WHERE "facilities"."id" = $1 LIMIT $2  [["id", ${facilityId}], ["LIMIT", 1]]`, "app/helpers/headless_helper.rb:6:in `find_by_id_or_uuid'");
  sql("ApiAssociation Exists?", ms(1.4, 6.5), `SELECT 1 AS one FROM "api_associations" INNER JOIN "client_applications" ON "client_applications"."id" = "api_associations"."client_application_id" WHERE "api_associations"."turned_on" = $1 AND "client_applications"."name" = $2 LIMIT $3  [["turned_on", true], ["name", "FMS"], ["LIMIT", 1]]`, "app/models/role.rb:73:in `can_access_application?'");
  sql("Flipper::Adapters::ActiveRecord::Gate Load", ms(1.1, 5.1), `SELECT "flipper_gates".* FROM "flipper_gates" WHERE "flipper_gates"."feature_key" = $1  [["feature_key", "flipper_up_corporate_search"]]`, "app/models/ability.rb:878:in `load_company_permissions'");
  out(`  ==> Requested authorization for: index, facility_dashboard`);
  return 12;
}

// --- scenarios -------------------------------------------------------------

function signIn() {
  maybeScope();
  started("POST", "/users/sign_in");
  processing("SessionsController", "create");
  out("");
  out("Parameters:");
  out(`{"user"=>{"login"=>"smallela_hyper", "password"=>"[FILTERED]"}, "commit"=>"Sign in"}`);
  sql("User Load", ms(1.4, 2.6), `SELECT "users".* FROM "users" WHERE ("users"."email" = 'smallela_hyper' OR "users"."username" = 'smallela_hyper') AND (users.deleted = false) ORDER BY "users"."id" ASC LIMIT $1  [["LIMIT", 1]]`, "app/models/user.rb:289:in `find_first_by_auth_conditions'");
  sql("TRANSACTION", ms(1.0, 1.9), "BEGIN", "app/controllers/application_controller.rb:283:in `check_password_expiry'");
  sql("User Update", ms(1.1, 2.0), `UPDATE "users" SET "sign_in_count" = $1, "current_sign_in_at" = $2 WHERE "users"."id" = $3  [["id", ${USER_ID}]]`, "app/controllers/application_controller.rb:283:in `check_password_expiry'");
  sql("TRANSACTION", ms(1.0, 1.5), "COMMIT", "app/controllers/application_controller.rb:283:in `check_password_expiry'");
  sql("Facility Load", ms(3.2, 6.0), `SELECT "facilities".* FROM "facilities" INNER JOIN "facilities_users" ON "facilities"."id" = "facilities_users"."facility_id" WHERE "facilities_users"."user_id" = $1 ORDER BY "facilities"."name" ASC  [["user_id", ${USER_ID}]]`, "app/models/user.rb:181:in `assign_all_facilities'");
  out("Redirected to https://fms.dev.cubesmart.com:3000/company/2/facility/725/dashboard");
  completed(302, Number(ms(260, 480)), null, ms(30, 84));
}

// The dashboard: heavy, many graphs, genuinely slow in the real log (2.4-3.1s).
function facilityDashboard() {
  maybeScope();
  const fac = pick([725, 34679, 21884]);
  started("GET", `/company/2/facility/${fac}/dashboard`);
  processing("FacilityDashboardController", "index");
  let db = authPreamble(fac);
  sql("Lead Load", ms(1.7, 52), `SELECT "leads".* FROM "leads" WHERE "leads"."facility_id" = $1 AND "leads"."closed" = $2 ORDER BY "leads"."updated_at" DESC  [["facility_id", ${fac}], ["closed", false]]`, "lib/facility_graphs/leads_graph.rb:19:in `open_leads'");
  sql("Tenant Load", ms(6.7, 29), `SELECT DISTINCT "tenants".* FROM "tenants" INNER JOIN "ledgers" ON "tenants"."id" = "ledgers"."tenant_id" WHERE "ledgers"."facility_id" = $1 AND "ledgers"."closed_on" IS NULL  [["facility_id", ${fac}]]`, "lib/facility_graphs/tenants_graph.rb:20:in `tenants'");
  sql("Unit Load", ms(1.7, 4.0), `SELECT "units".* FROM "units" WHERE "units"."facility_id" = $1 AND (units.deleted = false) ORDER BY "units"."sort_string" ASC  [["facility_id", ${fac}]]`, "lib/facility_graphs/advanced_unit_graph.rb:50:in `units'");
  sql("Ledger Load", ms(1.6, 29), `SELECT "ledgers".* FROM "ledgers" WHERE "ledgers"."facility_id" = $1 AND "ledgers"."past_due_on" IS NOT NULL  [["facility_id", ${fac}]]`, "lib/facility_graphs/overdue_graph.rb:25:in `overdue_ledgers'");
  sql("Event Load", ms(1.4, 9.4), `SELECT COUNT(*) FROM "events" WHERE "events"."type" IN ($1, $2) AND "events"."facility_id" = $3  [["type", "MoveInUnitEvent"], ["facility_id", ${fac}]]`, "lib/facility_graphs/tenants_graph.rb:12:in `graph_data'");
  db += 90;
  sql("Facility Load", ms(6.8, 9.2), `SELECT "facilities"."id", "facilities"."name" FROM "facilities" WHERE "facilities"."company_id" = $1 ORDER BY "facilities"."name" ASC  [["company_id", 2]]`, "app/views/layouts/_facility_switcher.html.erb:10");
  completed(200, Number(ms(1700, 3100)), ms(1380, 2320), db.toFixed(1));
}

// The N+1 seen in the real log: LedgerDelinquency#delinquent? per event row.
function tenantShowNPlusOne() {
  maybeScope();
  const tenant = id();
  started("GET", `/company/2/facility/725/tenants/${tenant}`);
  processing("TenantsController", "show");
  let db = authPreamble(725);
  sql("Tenant Load", ms(2.9, 9.5), `SELECT "tenants".* FROM "tenants" WHERE "tenants"."facility_id" = $1 AND "tenants"."id" = $2 LIMIT $3  [["facility_id", 725], ["id", ${tenant}], ["LIMIT", 1]]`, "app/helpers/headless_helper.rb:6:in `find_by_id_or_uuid'");
  sql("UnitEvent Load", ms(2.2, 3.3), `SELECT "events".* FROM "events" WHERE "events"."type" IN ($1, $2, $3) AND "events"."facility_id" = $4 ORDER BY created_at DESC LIMIT $5  [["facility_id", 725], ["LIMIT", 10]]`, "app/views/facility_dashboard/_unit_activity.html.erb:3");
  // one query per row — the classic N+1
  for (let i = 0; i < 9; i++) {
    const d = ms(1.0, 1.3);
    db += Number(d);
    sql("LedgerDelinquency Load", d, `SELECT "ledger_delinquencies".* FROM "ledger_delinquencies" WHERE "ledger_delinquencies"."ledger_id" = $1 AND "ledger_delinquencies"."exited_delinquency_at" IS NULL LIMIT $2  [["ledger_id", ${id()}], ["LIMIT", 1]]`, "app/models/ledger.rb:1763:in `delinquent?'");
  }
  sql("Note Exists?", ms(163, 285), `SELECT 1 AS one FROM "notes" INNER JOIN "events" ON "notes"."event_id" = "events"."id" WHERE "events"."tenant_id" = $1 AND "notes"."important" = $2 LIMIT $3  [["tenant_id", ${tenant}], ["important", true], ["LIMIT", 1]]`, "app/helpers/notes_helper.rb:149:in `render_important_note_hovercard_badge'");
  sql("Contact Load", ms(33, 75), `SELECT "contacts".* FROM "contacts" WHERE "contacts"."tenant_id" = $1 AND (contacts.deleted = false)  [["tenant_id", ${tenant}]]`, "app/controllers/tenants_controller.rb:102:in `show'");
  sql("LineItem Load", ms(21, 74), `SELECT "line_items".* FROM "line_items" INNER JOIN "account_balances" ON "line_items"."id" = "account_balances"."accountable_id" WHERE "account_balances"."ledger_id" = $1 LIMIT $2  [["LIMIT", 1]]`, "app/models/ledger.rb:1103:in `paid_through_for_invoiceable'");
  db += 400;
  completed(200, Number(ms(3800, 7400)), ms(2100, 4450), db.toFixed(1));
}

// The review_cost 500 observed in the captured FMS traffic.
function reviewCost500() {
  maybeScope();
  started("POST", `/v1/${FACILITY_UUID}/move_ins/review_cost`);
  processing("Api::MoveIns::ReviewCostController", "create", "JSON");
  out("");
  out("Parameters:");
  out(`{"facility_id"=>"${FACILITY_UUID}", "unit_id"=>"${id()}", "move_in_date"=>"2026-08-14"}`);
  sql("ClientApplication Load", ms(0.8, 1.5), `SELECT "client_applications".* FROM "client_applications" WHERE "client_applications"."key" = $1 LIMIT $2`, "app/models/client_application.rb:44:in `authenticate'");
  sql("OauthNonce Load", ms(0.4, 1.0), `SELECT "oauth_nonces".* FROM "oauth_nonces" WHERE "oauth_nonces"."nonce" = $1 LIMIT $2`, "lib/oauth/request_proxy.rb:31:in `valid_nonce?'");
  sql("Facility Load", ms(0.9, 1.6), `SELECT "facilities".* FROM "facilities" WHERE "facilities"."uuid" = '${FACILITY_UUID}' LIMIT $1`, "app/services/current_facility_service.rb:15:in `process'");
  sql("Unit Load", ms(0.9, 1.8), `SELECT "units".* FROM "units" WHERE "units"."id" = $1 LIMIT $2`, "app/forms/api/move_ins/move_in_review_cost_form.rb:41:in `unit'");
  sql("DiscountPlan Load", ms(1.6, 3.1), `SELECT "discount_plans".* FROM "discount_plans" INNER JOIN "facility_discount_plans" ON "discount_plans"."id" = "facility_discount_plans"."discount_plan_id" WHERE "facility_discount_plans"."facility_id" = $1`, "app/models/discount_plan.rb:114:in `currently_available'");
  sql("ServicePeriod Load", ms(0.9, 1.7), `SELECT "service_periods".* FROM "service_periods" WHERE "service_periods"."ledger_id" = $1`, "app/services/move_ins/update_ledger_service.rb:38:in `service_periods'");
  sql("InvoiceableAmount Load", ms(1.0, 2.3), `SELECT "invoiceable_amounts".* FROM "invoiceable_amounts" WHERE "invoiceable_amounts"."invoiceable_id" = $1 ORDER BY "invoiceable_amounts".limit ASC NULLS LAST LIMIT $2`, "app/helpers/invoiceable_items_helper.rb:7:in `display_invoiceable_item_price'");
  out("NoMethodError (undefined method `prorated_amount' for nil:NilClass):");
  out("  app/forms/api/move_ins/move_in_review_cost_form.rb:87:in `calculate_first_month'");
  out("  app/services/move_ins/update_ledger_service.rb:42:in `call'");
  completed(500, Number(ms(180, 460)), null, ms(20, 60));
}

function pusherAuth() {
  started("POST", `/company/2/facility/725/pusher/auth`);
  processing("PusherController", "authentication", "*/*");
  const db = authPreamble(725);
  out(`Signing ${id()}.${id()}:private-facility-4fe9d1c1d67940b2bc90add7fe07972e`);
  completed(200, Number(ms(240, 300)), ms(0.3, 1.0), db.toFixed(1));
}

function unauthorized() {
  started("GET", "/hyper/companies");
  processing("Hyper::CompaniesController", "index");
  sql("User Load", ms(1.2, 1.6), `SELECT "users".* FROM "users" WHERE "users"."id" = $1 ORDER BY "users"."id" ASC LIMIT $2  [["id", ${USER_ID}], ["LIMIT", 1]]`, null);
  sql("StoredgeIdp::AccessToken Load", ms(1.0, 1.6), `SELECT "idp_access_tokens".* FROM "idp_access_tokens" WHERE "idp_access_tokens"."user_id" = $1  [["user_id", ${USER_ID}]]`, "engines/storedge_idp/app/models/storedge_idp/idp_account.rb:12:in `cleanup_sessions'");
  completed(401, Number(ms(9, 250)), null, ms(0, 30));
}

// --- Discourse mode -------------------------------------------------------
//
// Emits traffic against controllers that REALLY EXIST in the indexed Discourse
// source, so the coverage view compares runtime against genuine static
// analysis rather than two unrelated applications.
const DISCOURSE = [
  ["TopicsController", "show", "GET", () => `/t/some-topic/${id() % 9000}`, ["topics", "posts", "topic_users"]],
  ["TopicsController", "index", "GET", () => `/latest`, ["topics", "categories"]],
  ["PostsController", "create", "POST", () => `/posts`, ["posts", "topics", "user_actions"]],
  ["PostsController", "show", "GET", () => `/posts/${id() % 9000}`, ["posts", "users"]],
  ["UsersController", "show", "GET", () => `/u/user${id() % 400}`, ["users", "user_profiles"]],
  ["CategoriesController", "index", "GET", () => `/categories`, ["categories", "topics"]],
  ["SearchController", "query", "GET", () => `/search?q=storage`, ["posts", "topics", "users"]],
  ["NotificationsController", "index", "GET", () => `/notifications`, ["notifications"]],
  ["SessionController", "create", "POST", () => `/session`, ["users"]],
  ["TagsController", "show", "GET", () => `/tag/announcements`, ["tags", "topics"]],
  ["BookmarksController", "create", "POST", () => `/bookmarks`, ["bookmarks", "posts"]],
  ["UploadsController", "create", "POST", () => `/uploads`, ["uploads"]],
];

function discourseRequest() {
  const [controller, action, verb, pathFn, tables] = pick(DISCOURSE);
  started(verb, pathFn());
  processing(controller, action, verb === "POST" ? "JSON" : "HTML");
  let db = 0;
  sql("User Load", ms(0.4, 1.6), `SELECT "users".* FROM "users" WHERE "users"."id" = $1 LIMIT $2  [["id", ${id() % 5000}], ["LIMIT", 1]]`, "app/controllers/application_controller.rb:302:in `current_user'");
  db += 1;
  for (const t of tables) {
    const d = ms(0.5, 14);
    db += Number(d);
    sql(
      `${t.replace(/s$/, "").replace(/^./, (c) => c.toUpperCase())} Load`,
      d,
      `SELECT "${t}".* FROM "${t}" WHERE "${t}"."id" = $1 LIMIT $2  [["id", ${id() % 9000}], ["LIMIT", 1]]`,
      `app/models/${t.replace(/s$/, "")}.rb:${40 + (id() % 400)}:in \`find_for_request'`
    );
  }
  // Occasional N+1 in the topic view, mirroring a real Discourse hot spot.
  if (controller === "TopicsController" && action === "show" && Math.random() < 0.4) {
    for (let i = 0; i < 8; i++) {
      const d = ms(0.4, 1.1);
      db += Number(d);
      sql("PostAction Load", d, `SELECT "post_actions".* FROM "post_actions" WHERE "post_actions"."post_id" = $1  [["post_id", ${id() % 9000}]]`, "app/models/post.rb:812:in `acted_on_by?'");
    }
  }
  const total = Number(ms(45, 900));
  completed(pick([200, 200, 200, 200, 302, 404]), total, ms(10, 300), db.toFixed(1));
}

const APP = opt("app", "discourse"); // demo default: matches the indexed source

const SCENARIOS = APP === "discourse" ? Array(12).fill(discourseRequest) : [
  ...Array(4).fill(facilityDashboard),
  ...Array(3).fill(tenantShowNPlusOne),
  ...Array(3).fill(pusherAuth),
  ...Array(2).fill(signIn),
  ...Array(2).fill(reviewCost500),
  unauthorized,
];

if (ONCE) {
  const once = APP === "discourse"
    ? Array(6).fill(discourseRequest)
    : [signIn, facilityDashboard, tenantShowNPlusOne, reviewCost500, pusherAuth, unauthorized];
  once.forEach((f) => f());
  process.exit(0);
}

console.error(`[sim] streaming ${APP === "discourse" ? "Discourse" : "FMS"}-shaped Rails log — ~1 request per ${RATE}ms. Ctrl-C to stop.`);
(function loop() {
  pick(SCENARIOS)();
  setTimeout(loop, RATE * (0.5 + Math.random()));
})();
