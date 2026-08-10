# Tesseract Lite — operator runbook

For whoever administers the instance. Installation is in
[UBUNTU-SETUP.md](UBUNTU-SETUP.md).

---

## Who sees what

| | Members (the 15 accounts) | Administrator |
|---|---|---|
| Chat, facet scoping, file downloads | yes | yes |
| Add / sync / delete content | yes | yes |
| Pipeline, Tuning, Admin | no — hidden, and blocked by URL | yes |

Administrator is a per-account flag, not a separate login. Grant it in
**Admin → Users & invites**.

---

## Everyday operations

### Add a GitHub repository

**Facets → Add → GitHub**, paste the URL. Ingestion runs in the background —
the progress bar is live and survives a restart. Private repositories need
`GITHUB_TOKEN` in `.env.local`.

### Add a Confluence space

One-time setup in **Admin → Settings → Confluence connector**: site URL, the
API token, and the email address that owns the token. Press **Test
connection** — it should name the authenticated user. Then **Facets → Add →
Confluence** and pick the space.

Re-syncing skips pages whose content has not changed.

### Keep content current

Each facet has a sync schedule: manual, every 6 hours, daily, or weekly. The
worker runs inside the app process; nothing to schedule in cron.

### Add a person

**Admin → Users & invites → Invite**, enter the email, send them the link.
Or add them to `MEMBERS` in `scripts/seed.mjs` and re-run `npm run seed` — it
creates only what is missing and prints the new password.

### Remove a person

**Admin → Users & invites → Delete**. Their chat history goes with them;
indexed content is owned by the organization and stays.

---

## Where the data lives

Everything is under `/opt/tesseract/app/data` — the SQLite database, uploaded
originals, and cloned repositories. There is no database server to run unless
you chose pgvector.

**Which vector store is active** is shown in **Admin → Tuning** as `sqlite-vec`
or `pgvector`, with the vector width beside it. It is chosen by the
`PGVECTOR_URL` variable in `.env.local`, not in the UI: unset means the
embedded index, set means PostgreSQL. Changing it needs a service restart.

Switching from sqlite-vec to pgvector copies existing vectors across on first
use, with no re-embedding, provided both were built by the same embedder. The
log line to look for is `pgvector: migrating N chunks…`.

If you run pgvector, remember it needs its own backup — the `data/` directory
no longer holds your vectors. See the Backups section of
[UBUNTU-SETUP.md](UBUNTU-SETUP.md).

---

## The two settings that actually matter

### Model per reasoning tier — Admin → Settings

Three tiers map to three Claude models. Members pick a tier per conversation;
you decide what each one costs.

| Tier | Default | Use it for |
|---|---|---|
| Low | `claude-haiku-4-5` | lookups, short factual questions |
| Medium | `claude-sonnet-5` | the everyday default |
| High | `claude-opus-5` | architecture questions, long synthesis |

**Refresh models** pulls the live list from Anthropic, so a newly released
model is a dropdown choice rather than an upgrade.

### Embedding provider — Admin → Settings

How your content is turned into searchable vectors. Chat is Claude either way.

- **Local** (default) — runs on the server. No second vendor, no key, nothing
  leaves the machine. First use loads the model, about 10 seconds.
- **OpenAI** — better retrieval on large technical corpora. Needs
  `OPENAI_API_KEY` in `.env.local`.

**Switching re-indexes everything.** The two produce different vector shapes,
so the existing index cannot be reused: it is rebuilt empty on the next
ingest, and every facet must be re-synced. On a large corpus that is hours.
Decide once, at install time, and leave it alone.

---

## Tuning (Admin → Tuning)

Retrieval parameters, with a live view of the corpus. Anything marked
*re-index* only affects content indexed after the change — existing material
keeps its current shape until you re-sync it.

- **Chunk size / overlap** — how much text goes into one searchable unit.
  Larger keeps context together but blurs the match; smaller is sharper but
  fragments reasoning. Default 3600 characters (~900 tokens).
- **Top-K** — how many chunks each search hands to Claude. Higher recall,
  more tokens, more distraction. Takes effect immediately.

The **Evaluation** tab builds a question set from your own corpus and scores
retrieval against it. Use it to justify a parameter change rather than
guessing — run it before and after.

---

## Monitoring

**Pipeline** shows ingestion jobs, embedding counts, token usage and errors.

Service health from the shell:

```bash
sudo systemctl status tesseract
sudo journalctl -u tesseract -f          # live logs
sudo journalctl -u tesseract --since "1 hour ago" | grep -i error
```

Watch two things: token spend in Pipeline (it maps directly to the Anthropic
bill) and disk on `/opt/tesseract/app/data`.

---

## Routine tasks

### Restart

```bash
sudo systemctl restart tesseract
```

In-flight answers are lost; queued ingestion jobs resume on their own.

### Rotate the Anthropic key

Edit `.env.local`, then restart. Indexed content is unaffected.

### Reset someone's password

There is no self-service password reset in this build. Delete the account in
**Admin → Users & invites** and re-invite them, or add their address to
`scripts/seed.mjs` and re-run the seed to generate a fresh password.

### Free up disk

Deleting a facet removes its documents, vectors, uploaded originals and any
cloned repository. `sudo du -sh /opt/tesseract/app/data/*` shows where the
space went.

---

## Troubleshooting

**"Credit balance is too low"**
The Anthropic account is out of credit. Top up at console.anthropic.com. No
redeploy needed.

**Answers have no citations**
Nothing is indexed yet, or the conversation is scoped to a facet that has no
matching content. Check **Pipeline** for the chunk count, and clear the facet
scope in the chat sidebar.

**An ingestion is stuck**
Check Pipeline for the error, then **Re-sync** on the facet. Repository clones
that fail are usually authentication — confirm `GITHUB_TOKEN` is set and still
valid.

**Retrieval quality is poor on a big codebase**
In order: raise Top-K to 12–16; if that is not enough, consider switching the
embedding provider to OpenAI — but read the re-index warning above first.

**Ingestion is slow, or times out, when several syncs overlap**
SQLite allows one writer at a time, so concurrent ingestions queue behind each
other. Either stagger the sync schedules, or move the vector store to pgvector
(step 4 of the setup guide), which handles concurrent writes properly.

**A member can reach an admin page**
They shouldn't be able to. Confirm their role in **Admin → Users & invites**;
role is read from the session cookie, so they must sign out and back in after
a change.
