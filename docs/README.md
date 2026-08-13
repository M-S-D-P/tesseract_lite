# Diagrams

Two sets of the same three diagrams. Same system, different audience — not the
same file with words removed.

| | `technical/` | `non-technical/` |
|---|---|---|
| For | engineers, architecture review | a sponsor or director |
| Names things as | files, tables, ports, dimensions | plain English, no product names |
| Answers | "how is it built and where does the data go" | "what is it, what does it need, can I trust it" |

Each file is a single-tab `.drawio`. Open at **app.diagrams.net → File → Open
from → Device**, or in VS Code with the *Draw.io Integration* extension. Every
element is an ordinary editable shape — no images, no embedded data.

## 1 — Environment

Where the software runs and what talks to what.

- `technical/1-environment.drawio` — one Ubuntu host under systemd, Node
  terminating TLS itself on 3005, the single Next.js process with its proxy gate,
  job worker, per-source log listeners and local embedder, the `data/` directory,
  optional PostgreSQL/pgvector, and every external service with required versus
  optional marked. FMS appears as it really participates: it pipes a copy of the
  log it already writes.
- `non-technical/1-environment.drawio` — one server inside our network, what
  stays on it, and the single thing that leaves (the paragraphs needed to answer
  a question).

## 2 — Data flow

How material becomes an answer.

- `technical/2-data-flow.drawio` — sources → acquire → extract and chunk →
  embed → store → answer, showing where the vector width is decided and why
  changing embedding provider rebuilds the index. The red boxes at the bottom are
  the join: runtime attribution against the indexed source.
- `non-technical/2-data-flow.drawio` — five numbered steps, with step 3 (the
  running system reporting what it actually did) called out as the part nothing
  else does.

## 3 — System design

The internal structure and the decisions behind it.

- `technical/3-system-design.drawio` — layered: client, edge, API routes, domain
  services, persistence, integrations. Plus three panels that are usually the
  real questions in review: the request lifecycle for one question, the
  deliberate constraints (one writer in SQLite, rolling window, durable jobs),
  and the security posture.
- `non-technical/3-system-design.drawio` — four questions a sponsor asks: what
  it does for us, what it needs, who sees what, and how we know it is honest.
  Including what to say out loud about the limits.

## Keeping them true

If you change how ingestion, storage or the runtime feed works, these are the
files to update — they are the picture people will hold you to. The claims in the
red boxes are the ones backed by `scripts/verify-metaprogramming.mjs`, and
`FMS-METAPROGRAMMING.md` walks the same ground in prose with FMS file and line
references.
