# Tesseract Lite

An internal knowledge assistant. Point it at your GitHub repositories,
Confluence spaces and documents; ask questions in plain English; get answers
with citations back to the exact file or page.

Powered by Claude. Runs entirely on one server — your content is indexed
locally in SQLite and never leaves the machine except as the text Claude needs
to answer the question in front of it.

## What it does

- **Chat with citations.** Answers quote the source and link to the file or
  Confluence page they came from.
- **Facets.** Group your content into named collections and scope a
  conversation to one of them. A facet is private to whoever added it unless
  they share it with the organization.
- **Connectors.** GitHub repositories — public or private, on any branch you
  choose — Confluence spaces, and direct uploads: PDF, DOCX, Markdown,
  spreadsheets, source files, whole folders.
- **Scheduled sync.** Keep a repository or space current every 6 hours, daily
  or weekly. Unchanged pages are skipped.
- **Code structure awareness.** For Rails codebases it extracts models,
  routes, controllers and jobs into a queryable graph, so "which model owns
  this table" is answered from structure, not text search.
- **File generation.** Ask for a spreadsheet, Word document, PDF or CSV and
  it produces a real file to download.
- **Diagrams.** Architecture and flow answers render as live diagrams.

## Getting started

On an Ubuntu server, one command does the whole thing — Node, service
account, build, TLS certificate, accounts and a systemd unit:

```bash
git clone https://github.com/M-S-D-P/tesseract_lite.git
cd tesseract_lite
sudo ./scripts/install-ubuntu.sh
```

It serves HTTPS directly at `https://10.2.0.28:3006` when it finishes — no
nginx or Apache in front. Add your `ANTHROPIC_API_KEY` to
`/opt/tesseract/app/.env.local` and restart, and it is ready.

Step-by-step and what the script is doing: **[UBUNTU-SETUP.md](UBUNTU-SETUP.md)**
Running it day to day: **[RUNBOOK.md](RUNBOOK.md)**

Local development:

```bash
npm install
cp .env.example .env.local     # add ANTHROPIC_API_KEY and AUTH_SECRET
npm run seed                   # creates the org and its accounts
npm run dev                    # http://localhost:3006
```

## Requirements

- Node.js 20 or newer
- An Anthropic API key with credit available
- ~2 GB disk for the app, plus room for whatever you index

Out of the box: no database server, no Docker, no second cloud vendor. Two
things are swappable if you want them.

- **Vector store** — the embedded sqlite-vec index by default. Set
  `PGVECTOR_URL` to use PostgreSQL + pgvector instead, which is worth doing
  once the corpus gets large or your DBAs want the vectors somewhere they
  already back up. Existing vectors migrate across without re-embedding.
- **Embeddings** — a model that runs on the server by default, needing no
  second vendor key. Switch to OpenAI in Admin if you want its retrieval
  quality and have a key.
