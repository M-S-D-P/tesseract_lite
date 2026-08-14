# Every question from the review, and where we actually stand

Compiled from the recorded conversation. Grouped, with an honest status against
each: **answerable now** with an artefact to point at, **open**, or **corrected**
where something said in the meeting does not match the code.

The governing rule for the follow-up: *be specific, or say "I don't know".*
Anything below marked open should be answered with those words rather than
filled in.

---

## Corrections to make unprompted

Two statements from the meeting will not survive checking. Better to lead with
them than be caught.

**1. "The log stream is immediately embedded — it's gone into pgvector."**
It is not. Runtime evidence is written to `runtime_requests`, `runtime_queries`
and now `runtime_methods` — ordinary relational tables — plus the `kg_*` graph.
**Nothing from the runtime feed is embedded, and none of it enters the vector
store.** The honest version is stronger: runtime facts are kept relationally and
joined at query time, so counts, timings, line numbers and bind values stay
exact instead of being approximated by similarity search. Embeddings are for
prose and code text, where fuzzy matching is what you want.

**2. "The user_id came from the log."** Probably true, but it was asserted
rather than shown, which is what triggered the comparison to consultants asking
to be trusted. Bind values *are* present in the Rails log — the paste from that
session contains `[["id", 16541050]]` and `[["address2", "teeadsdfsd"]]` — and
the parser stores the whole statement including binds in `runtime_queries.sql`.
Answer it by putting that row on screen, not by re-asking the model.

---

## A. Can the model do this at all?

His central objection, and the one to concede rather than argue.

| # | Question | Status |
|---|---|---|
| 1 | Prove Claude was trained on Ruby **and** Rails — specific versions, with citations | **Open.** A vendor blog post about benchmark categories is not evidence. |
| 2 | Prove it understands the Ruby parser/AST, not just how to write a script | **Open.** |
| 3 | *"Show me the implementation of this method in the Ruby core"* — his stated bar | **Open.** |
| 4 | How does it know which method is invoked when the class is resolved at runtime from config or a database value? | **Answerable — by not needing to know.** |
| 5 | Ruby is a DSL: one call fans out into hundreds of gem-internal calls. How can anything outside the gem understand that? | **Answerable — same way.** |

**The answer to 4 and 5 is to stop defending the premise.** We do not claim the
model knows what Rails will generate. We *observe what ran* and hand it over as
fact. The model's job is to explain code we have already proven executed, not to
predict metaprogramming from training data. That reframing turns 1–3 from
blockers into curiosities: if the evidence is observed, it does not matter
whether the model was trained on Rails 6.1 specifically.

Where the model is still load-bearing — summarising, tracing, drafting — the
mitigation is that every claim cites a file and line, so a wrong answer is
visible rather than plausible.

---

## B. What did you actually build, beyond a RAG?

| # | Question | Answer |
|---|---|---|
| 6 | *"If I download a LangChain RAG and connect the same sources, how is yours different?"* | A vanilla RAG has one half of the picture — the source. It cannot tell you which controllers serve no traffic, which methods executed that are written nowhere, or which SQL a given line issued. Those come from the runtime feed, and from the join between the two. |
| 7 | What does "merging" physically mean, and in which database? | No merge into one store. Source text and prose live as chunks + embeddings; runtime facts live relationally. They are joined **at query time**: `runtime_queries.source` and `runtime_methods.path` against `chunks.meta.path`. `metaprogrammingReport()` in `src/lib/runtime/store.ts` is that join, in about forty lines. |
| 8 | Where is the block diagram? | `docs/technical/` (environment, data flow, system design) and `docs/non-technical/` for the sponsor version. |
| 9 | What is uniquely captured versus a standard pipeline? | Per-request source attribution (`file:line:in 'method'`), N+1 verdicts with the statement, per-method call counts and locations from AppMap, controller coverage against the indexed source, and the metaprogramming verdicts. |
| 10 | Does the design address runtime resolution at all — draw it | Yes: the red boxes in `docs/technical/2-data-flow.drawio`. |
| 11 | Why parse the source at all instead of using reflection? | Reflection requires booting the app with the right data and gems, and answers only about the objects you happen to reach. Parsing covers the whole repository cheaply and offline. We use both, which is the point — neither alone is sufficient. |

---

## C. The evidence itself

| # | Question | Answer |
|---|---|---|
| 12 | Show line numbers, and where each fact came from | Every finding carries file, line, execution count, elapsed time, and how much indexed source backed the verdict. |
| 13 | Where are the SQL bind values? If it wasn't logged, how is it in your database? | They are in the log and stored verbatim in `runtime_queries.sql`. Show the row. Nothing is inferred or reconstructed. |
| 14 | Is everything in the tail exactly what's in the DB, nothing more? | Yes — and this is worth saying plainly. The parser only ever reads what the log emitted. If a value was not logged, it is not in the database. |
| 15 | Did the user_id come from the log or the URL? | See the correction above: prove it from the stored statement. |
| 16 | *"Map it back on paper — how the data relates. Without that I can't trust it."* | The data-flow diagram, plus `scripts/verify-metaprogramming.mjs`, which proves the hardest claim against a fixture whose answer is known in advance and **fails loudly** when wrong. |

---

## D. Logging mechanics

| # | Question | Answer |
|---|---|---|
| 17 | Is Rails logging automatic, or must developers add statements? | Automatic. `ActiveSupport::Logger` with Rails' instrumentation emits the request line, the controller and action, each SQL statement with binds, the `↳` source attribution, view timings and the completion line. No developer writes those, and we add nothing to FMS. |
| 18 | Which logger? | `ActiveSupport::Logger`, the one FMS already uses. |
| 19 | What log level, and what does each emit? | `debug` for the SQL and source-attribution lines. `info` gives request and completion lines but drops the per-query detail that this depends on. |
| 20 | **Does AppMap listen to the same thing, and what is inside AppMap versus the logs?** | Answered below. This was the hinge of the conversation. |

---

## The answer to 20, which is also the biggest upgrade available

They are **not** the same source, and AppMap is strictly richer.

| | Rails debug log | AppMap |
|---|---|---|
| A method appears when… | it happened to be on the stack **when SQL was issued** | **every instrumented call** |
| Method identity | parsed out of a `↳ file:line:in 'frame'` string | `defined_class` + `method_id` + `static`, structured |
| Where the method is defined | inferred from the frame label | `path` + `lineno` — literally `Method#source_location` |
| Values | bind arrays, when present | `parameters` and `return_value` per call |
| Shape | flat list per request | real call tree with per-call `elapsed` |

The consequence matters for his objection specifically. A generated method that
**touches no database** emits no `↳` line and is invisible to the log — that was
the documented limit of the earlier approach. AppMap sees it, because it records
the call itself.

**This is now implemented.** `src/lib/appmap.ts` extracts every function the
trace observed together with its `source_location`, stores them in
`runtime_methods`, and `metaprogrammingReport()` checks each against the indexed
source. Findings carry an `origin` of `appmap` or `log` so the grade of evidence
is visible, and the chat tool is instructed to say which one it is citing.

The verifier proves it: a fixture method generated by a macro that issues no SQL
whatsoever is found via AppMap and reported as generated, and a hand-written
method located at its own `def` is not. Twelve assertions, passing in both
repositories.

```bash
node scripts/verify-metaprogramming.mjs \
  --base http://localhost:3005 --email you@example.com --password '...'
```

---

## What to do before the next conversation

1. **Lead with the two corrections.** Volunteering them buys more credibility
   than any demo.
2. **Record an AppMap trace of one FMS request** — the tenant update or the
   auctions page from `FMS-METAPROGRAMMING.md` — and upload it as a facet. That
   converts question 20 from a claim into a screen.
3. **Run the verifier in front of him.** It fails loudly; that is the feature.
4. **Say "I don't know" to A1–A3** and pivot to the reframing: we do not depend
   on the model knowing Rails, and here is the evidence chain that shows why.
5. **Show the join in code.** It is forty lines in `store.ts`. He asked what was
   built beyond a RAG; that function is the honest answer, and it is short
   enough to read together.
