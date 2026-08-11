# Tesseract Lite — operator runbook

For whoever administers the instance. Installation is in
[UBUNTU-SETUP.md](UBUNTU-SETUP.md).

---

## Who sees what

| | Members (the 15 accounts) | Administrator |
|---|---|---|
| Chat, facet scoping, file downloads | yes | yes |
| Add content, and sync or delete their own | yes | yes |
| See someone else's private facet | no | no |
| Sync or delete someone else's facet | no | yes |
| Change their own password | yes | yes |
| Pipeline, Tuning, Admin | no — hidden, and blocked by URL | yes |
| Reset another person's password | no | yes |
| Configure connectors, models, embeddings | no | yes |

Administrator is a per-account flag, not a separate login. Grant it in
**Admin → Users & invites**.

---

## Everyday operations

### Add a GitHub repository

**Facets → Add → GitHub**, paste the URL. Ingestion runs in the background —
the progress bar is live and survives a restart.

**Branches.** Once the URL is recognised, the branch list loads and you pick
one; leaving it blank tracks the repository default. Pasting a URL copied from
the browser while viewing a branch (`.../tree/release-2.1`) preselects that
branch. Re-syncing always stays on the branch the facet was added with, so a
scheduled sync never quietly jumps to `main`.

To index two branches of the same repository, add it twice and pick a
different branch each time. They are separate facets, separately scoped in
chat, and each costs its own embedding pass.

The branch a facet tracks is shown next to its name.

**Private repositories.** Add a token in **Admin → Settings → GitHub
connector** and press Test connection. Classic PAT with the `repo` scope, or a
fine-grained token with Contents: Read on the repositories you want. Public
repositories need no token. If `GITHUB_TOKEN` is set in `.env.local` it is
used whenever the Admin field is blank.

A private repository with no working token fails at clone time with a message
saying so, rather than a generic git error.

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

**Admin → Users & invites → Invite**, enter the email, then copy the link and
send it to them yourself — over Teams, Outlook, however you normally would.

**There is no mail server, by design.** Nothing is emailed automatically and
nothing is failing silently; the invite link is the whole mechanism. It is
valid for seven days.

Alternatively add them to `MEMBERS` in `scripts/seed.mjs` and re-run
`npm run seed`. They get the same shared starting password as everyone else
(`cs2026x` unless you changed it) and must replace it on first sign-in.

### Remove a person

**Admin → Users & invites → Delete**. Their chat history goes with them;
indexed content is owned by the organization and stays.

---

## Who can see which facets

**A facet belongs to the person who added it and is private by default.** It
appears only in their facet list, and only their questions retrieve from it.
Nobody else — including administrators, in chat — gets answers grounded in it.

To make one available to everyone, tick **Share with everyone** when adding
it, or use the padlock button in the facet list afterwards. Shared facets are
marked *shared*, with the owner's address underneath, and anyone can scope a
conversation to them.

Only the owner can re-sync, reschedule or delete a facet. Administrators can
too, so that facets belonging to someone who has left can be cleaned up.

**Which one to use.** Shared is usually right for the common corpus — a
repository indexed once as shared costs one embedding pass and one copy on
disk, where fifteen people each adding it privately costs fifteen of each.
Private is right for a personal scratch area, or a repository the rest of the
team should not be reading.

Facets that already existed before this became per-user were left shared, so
nothing disappeared from anyone's list on upgrade.

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

### Passwords

**Someone wants to change their own:** the key icon in the top bar, or
`/change-password` directly. They need their current one. Minimum ten
characters.

**Someone is locked out:** **Admin → Users & invites → Reset password** next
to their name. A temporary password appears on screen once — it is not stored
in readable form anywhere, so if you lose it, issue another. Read it to them
over a channel you trust; their old password stops working immediately. Note
this is a freshly generated password, not `cs2026x`.

Accounts holding a password they did not choose — everyone straight after
`npm run seed`, and anyone you have just reset — are marked **password not set
yet** in the user list. Those accounts can sign in and do exactly one thing:
set their own password. Every other page and API returns 403 until they do.

**Someone forgot theirs and no administrator is available:** there is no email
reset, because the server has no mail configuration and that was a deliberate
choice. An administrator has to issue a temporary password. Adding self-service
email reset would mean SMTP credentials and a change to the build.

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
that fail are usually authentication — press Test connection in **Admin →
Settings → GitHub connector**.

**"Branch X does not exist"**
The branch was deleted or renamed after the facet was added. Delete the facet
and add it again on a branch that exists; the tracked branch is fixed once set.

**Someone says a document is missing from answers**
Check who owns the facet. If it is private to a colleague, their material will
never appear in this person's answers by design — the owner has to share it.

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
