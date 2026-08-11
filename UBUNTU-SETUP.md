# Installing Tesseract Lite on Ubuntu

Written for Ubuntu 22.04 LTS and 24.04 LTS. Every command is run as a user
with `sudo`. Total time: about 20 minutes, most of it waiting on `npm ci`.

The result: the app running under systemd as a dedicated service account,
serving HTTPS directly on port 3005, starting automatically on reboot. There
is no reverse proxy — Node terminates TLS itself.

---

## The short version

```bash
git clone https://github.com/M-S-D-P/tesseract_lite.git
cd tesseract_lite
sudo ./scripts/install-ubuntu.sh
```

That script does everything in this guide: installs Node and the build
toolchain, creates the `tesseract` service account, copies the app into
`/opt/tesseract/app`, generates a self-signed TLS certificate for the host,
writes `.env.local` with a random `AUTH_SECRET`, builds, seeds the accounts,
and registers and starts the systemd unit. It prints the seeded passwords
once at the end.

It is safe to re-run: it will not overwrite `.env.local`, an existing
certificate, or existing accounts.

Different address or port:

```bash
sudo BIND_HOST=10.2.0.28 PORT=3005 ./scripts/install-ubuntu.sh
```

Afterwards there is exactly one thing left to do — put your Anthropic key in
`/opt/tesseract/app/.env.local` and restart:

```bash
sudo nano /opt/tesseract/app/.env.local     # ANTHROPIC_API_KEY=sk-ant-...
sudo systemctl restart tesseract
```

The rest of this document is the same work done by hand, for when you want to
understand or change a step.

---

## 1. What you need before you start

| Thing | Why | Where it comes from |
|---|---|---|
| Ubuntu server, 2 vCPU / 4 GB RAM minimum | 4 GB is comfortable; the local embedder is the memory-hungry part | your infrastructure team |
| An Anthropic API key with credit | every answer is a Claude call | console.anthropic.com → API keys |
| The address users will reach it on | this deployment uses `10.2.0.28:3005` | your infrastructure team |
| GitHub token (optional) | only for **private** repositories | github.com → Settings → Developer settings |

Disk: 20 GB is plenty for the app and a few large repositories. Indexing a
very large codebase is the main consumer.

You do **not** need a database server — see step 3. PostgreSQL with pgvector
is supported as an alternative vector store and is covered in step 4, but it
is entirely optional.

You do **not** need Apache or nginx. The app listens on 3005 with TLS of its
own. If your environment requires everything to sit behind Apache, there is an
appendix at the end.

---

## 2. Install Node.js 20

Ubuntu's own `nodejs` package is too old. Use NodeSource:

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Check it:

```bash
node --version     # v20.x or newer
npm --version
```

`build-essential` and `python3` are not optional — `better-sqlite3` compiles a
native module during install and fails without a C++ toolchain.

---

## 3. The database

**There is nothing to install, and no database server to run.** This trips
people up, so it is worth being explicit.

Tesseract Lite stores everything — accounts, chats, documents, and the vector
index used for search — in a single SQLite file at
`/opt/tesseract/app/data/tesseract.db`. SQLite is a library, not a service:
no daemon, no listening port, no user accounts, no `CREATE DATABASE`. The file
is created automatically the first time the app or the seed script runs.

Two pieces do the work, and both arrive with `npm ci` in step 8:

| Package | What it is | Installed by |
|---|---|---|
| `better-sqlite3` | SQLite itself, compiled against your Node | `npm ci` (needs the toolchain from step 2) |
| `sqlite-vec` | vector-search extension, loaded into SQLite at startup | `npm ci` — ships a prebuilt binary |

So the only OS-level requirement for the database is the compiler toolchain
you already installed. Do **not** `apt install sqlite3` expecting the app to
use it — that is a separate command-line client, and the app ignores it.

### Optional: the sqlite3 CLI for inspection

Useful for backups and spot checks. It does not affect the running app:

```bash
sudo apt install -y sqlite3
```

Then, for example:

```bash
sudo -u tesseract sqlite3 /opt/tesseract/app/data/tesseract.db \
  "SELECT email, role FROM users ORDER BY role;"

sudo -u tesseract sqlite3 /opt/tesseract/app/data/tesseract.db \
  "SELECT COUNT(*) AS chunks FROM chunks;"
```

### What lives where

```
/opt/tesseract/app/data/
├── tesseract.db          the database
├── tesseract.db-wal      write-ahead log  ── part of the database,
├── tesseract.db-shm      shared memory    ── never copy the .db alone
├── uploads/              original files, kept so a re-index needs no re-upload
└── repos/                working clones of indexed Git repositories
```

The app runs SQLite in WAL mode, which is why `-wal` and `-shm` appear
alongside the database. Copying only `tesseract.db` from a running instance
gives you a torn backup — use the `.backup` command shown in the Backups
section, which is safe while the service is live.

### Sizing and permissions

Budget roughly 3–4× the raw size of what you index: the text is stored once as
chunks and once again as vectors, plus the original in `uploads/`. A few large
repositories land in the low hundreds of MB.

The whole directory must be owned by the service account:

```bash
sudo chown -R tesseract:tesseract /opt/tesseract/app/data
```

A `SQLITE_READONLY` or `attempt to write a readonly database` error in the
logs almost always means something was run as `root` and left a file behind
with the wrong owner. The fix is the `chown` above.

---

## 4. Optional: PostgreSQL + pgvector

Skip this section unless you want it — sqlite-vec from step 3 is a complete,
working index on its own, and nothing below is needed to get the app running.

Use pgvector when the corpus gets large (roughly past a few hundred thousand
chunks), when several ingestions run concurrently and SQLite's single-writer
lock starts to bite, or when your DBAs want the vectors in a database they
already back up and monitor.

The app picks the backend from one environment variable. Set `PGVECTOR_URL`
and it uses Postgres; leave it unset and it uses sqlite-vec. Document and
account metadata stays in SQLite either way — Postgres holds only chunks and
embeddings.

### Install PostgreSQL 16 and the extension

```bash
sudo apt install -y postgresql postgresql-contrib postgresql-16-pgvector
sudo systemctl enable --now postgresql
psql --version
```

If `postgresql-16-pgvector` is not found, your release predates it. Add the
official PostgreSQL repository and retry:

```bash
sudo apt install -y curl ca-certificates
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update
sudo apt install -y postgresql-16 postgresql-16-pgvector
```

### Create the database and role

Use a real password, not the one below:

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE tesseract WITH LOGIN PASSWORD 'CHANGE_ME_TO_SOMETHING_RANDOM';
CREATE DATABASE tesseract OWNER tesseract;
SQL

sudo -u postgres psql -d tesseract -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

The extension has to be created by a superuser, which is why that last line is
separate. The app creates its own table and indexes on first use.

Confirm the extension is live:

```bash
sudo -u postgres psql -d tesseract -c "\dx vector"
```

### Point the app at it

Add to `/opt/tesseract/app/.env.local` (created in step 7 below — come back
here once it exists):

```ini
PGVECTOR_URL=postgresql://tesseract:CHANGE_ME_TO_SOMETHING_RANDOM@localhost:5432/tesseract
```

Restart the service afterwards. On the next ingestion or search the app
creates the `chunks` table, and — if a sqlite-vec index already exists and was
built by the same embedder — copies those vectors straight across. That
migration costs no re-embedding and logs `pgvector: migrating N chunks…`. If
the widths differ (because the embedding provider changed) it says so and
leaves the table empty for you to re-sync.

Keep the database local. If you must reach it across a network, require TLS
and add `?sslmode=require` to the URL.

### Which backend am I on?

**Admin → Tuning** shows the live store as `sqlite-vec` or `pgvector`, with
the vector width beside it. From the shell:

```bash
sudo -u tesseract psql "$PGVECTOR_URL" -c "SELECT COUNT(*) FROM chunks;"
```

### Backing it up

pgvector data is **not** covered by the `data/` backup in the Backups section —
that only holds SQLite, uploads and clones. Add a dump:

```bash
sudo -u postgres pg_dump -Fc tesseract \
  -f /opt/tesseract/backups/tesseract-pg-$(date +%F).dump
```

Restore with `pg_restore -d tesseract`. Strictly speaking the vectors are
reproducible by re-syncing every facet, but on a large corpus that is hours of
embedding — back it up.

### Going back to sqlite-vec

Remove `PGVECTOR_URL` and restart. The SQLite index is still there, though it
will be stale for anything ingested while Postgres was in charge — re-sync
those facets.

---

## 5. Create the service account and directory

Running a web app as `root` or as a person's login is a bad habit. Give it its
own unprivileged account:

```bash
sudo useradd --system --create-home --home-dir /opt/tesseract --shell /usr/sbin/nologin tesseract
```

---

## 6. Get the code

```bash
sudo -u tesseract git clone https://github.com/M-S-D-P/tesseract_lite.git /opt/tesseract/app
cd /opt/tesseract/app
```

For a private repository, clone with a token or deploy key:

```bash
sudo -u tesseract git clone https://<TOKEN>@github.com/M-S-D-P/tesseract_lite.git /opt/tesseract/app
```

---

## 7. Configure

```bash
sudo -u tesseract cp .env.example .env.local
sudo -u tesseract nano .env.local
```

Fill in:

```ini
ANTHROPIC_API_KEY=sk-ant-...
AUTH_SECRET=<paste the output of: openssl rand -base64 48>
APP_URL=https://10.2.0.28:3005
PORT=3005
HOSTNAME=0.0.0.0

# Generated in the next step.
TLS_CERT_PATH=/opt/tesseract/app/certs/server.crt
TLS_KEY_PATH=/opt/tesseract/app/certs/server.key
```

`HOSTNAME=0.0.0.0` makes it listen on every interface. Bind it to one address
instead if the box is multi-homed and you only want it on the internal
network.

Then lock the file down — it holds your API key:

```bash
sudo chmod 600 /opt/tesseract/app/.env.local
sudo chown tesseract:tesseract /opt/tesseract/app/.env.local
```

**On `AUTH_SECRET`:** generate a real random value. If you leave it blank the
app falls back to a built-in development string, and anyone who knows it can
forge a session cookie for your instance. Changing it later is safe — it just
signs everyone out.

---

## 8. Install and build

```bash
cd /opt/tesseract/app
sudo -u tesseract npm ci
sudo -u tesseract npm run build
```

`npm ci` takes a few minutes and compiles `better-sqlite3`. The build prints a
route table when it succeeds.

---

## 8a. The TLS certificate

The app serves HTTPS itself, so it needs a certificate and key. A public CA
cannot issue one for a private address like `10.2.0.28`, so unless you have an
internal CA, this is self-signed.

```bash
sudo -u tesseract mkdir -p /opt/tesseract/app/certs
sudo -u tesseract openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout /opt/tesseract/app/certs/server.key \
  -out    /opt/tesseract/app/certs/server.crt \
  -subj "/CN=10.2.0.28/O=CubeSmart/OU=Tesseract" \
  -addext "subjectAltName=IP:10.2.0.28" \
  -addext "basicConstraints=CA:FALSE" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"

sudo chmod 600 /opt/tesseract/app/certs/server.key
sudo chmod 644 /opt/tesseract/app/certs/server.crt
```

**`subjectAltName` is not optional.** Modern browsers ignore the common name
entirely; without the `IP:` entry every visit fails with
`ERR_CERT_COMMON_NAME_INVALID` and there is no way to click past it. Use
`DNS:hostname` instead of `IP:` if you are serving on a name.

Because it is self-signed, browsers show a warning on first visit. Three ways
to deal with that, best first:

1. Have your internal CA issue the certificate, and replace the two files.
   The CA is already trusted on managed machines, so nothing warns.
2. Push `server.crt` to clients as a trusted root via group policy.
3. Let people click through the warning once per browser. Workable for
   fifteen users; it does train them to dismiss certificate warnings, which
   is a habit worth not building.

If your CA sends an intermediate chain, save it alongside and add
`TLS_CA_PATH=/opt/tesseract/app/certs/chain.pem` to `.env.local`.

---

## 9. Create the accounts

```bash
sudo -u tesseract npm run seed
```

This creates the **CubeSmart** organization, the administrator account and the
fifteen member accounts. Every one of them starts on the same password:

```
cs2026x
```

So the rollout message is one sentence: *sign in at
https://10.2.0.28:3005 with your work email and `cs2026x`, and pick your own
password when it asks.*

**That shared password is safe only because it cannot be used for anything
else.** Signing in with it leads straight to a change-password screen, and
every other page and API refuses the account until a new password is set. Ten
characters minimum.

Change it with `SEED_PASSWORD=something-else npm run seed`. Do not set
`SEED_FORCE_PASSWORD_CHANGE=false` — without the forced change, a password
that lives in a file in the repository becomes the real credential for
sixteen accounts.

The account list is written to `data/seed-credentials.txt` for your records.
It holds no secrets now, but delete it once the rollout is done:

```bash
sudo -u tesseract cat data/seed-credentials.txt
sudo -u tesseract rm data/seed-credentials.txt
```

Re-running `npm run seed` later is safe: it adds only missing accounts and
never touches an existing password. Someone who has already chosen their own
password keeps it.

---

## 10. Run it under systemd

```bash
sudo nano /etc/systemd/system/tesseract.service
```

```ini
[Unit]
Description=Tesseract Lite
After=network.target

[Service]
Type=simple
User=tesseract
Group=tesseract
WorkingDirectory=/opt/tesseract/app
Environment=NODE_ENV=production
# server.mjs reads PORT, HOSTNAME and the TLS paths from .env.local.
ExecStart=/usr/bin/node /opt/tesseract/app/server.mjs
Restart=always
RestartSec=5

# The app only ever writes inside its own directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/tesseract/app

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tesseract
sudo systemctl status tesseract
```

It should report `active (running)`. The log line on startup tells you which
scheme it picked:

```bash
sudo journalctl -u tesseract -n 5 --no-pager
# Tesseract Lite ready on https://0.0.0.0:3005
```

If it says `http://` instead, the TLS paths in `.env.local` are missing or
wrong and it fell back to plain HTTP. Confirm it answers — `-k` because the
certificate is self-signed:

```bash
curl -kI https://localhost:3005/login     # expect HTTP/1.1 200 OK
```

### Open the port

```bash
sudo ufw allow OpenSSH
sudo ufw allow 3005/tcp
sudo ufw enable
```

Ports above 1024 need no special privileges, which is why the service runs
unprivileged and still binds 3005 directly.

That is the whole deployment — carry on to step 11.

---

## 11. First login

Open `https://10.2.0.28:3005` and sign in as `smallela@cubesmart.com` with
`cs2026x`. You will be asked to choose your own password before anything else
becomes available.

Then, as administrator:

1. **Admin → Settings** — confirm the embedding provider is **Local**, and
   press **Refresh models** to pull the current Claude list.
2. **Facets** — add your first GitHub repository or Confluence space.
3. Ask a question in chat and check the answer carries citations.

Day-to-day operation is in [RUNBOOK.md](RUNBOOK.md).

---

## Upgrading

```bash
cd /opt/tesseract/app
sudo systemctl stop tesseract
sudo -u tesseract cp data/tesseract.db data/tesseract.db.bak
sudo -u tesseract git pull
sudo -u tesseract npm ci
sudo -u tesseract npm run build
sudo systemctl start tesseract
```

Schema changes are applied automatically at startup; indexed content survives.

---

## Backups

Everything that matters is in one directory: `/opt/tesseract/app/data`
(the SQLite database, uploaded originals, cloned repositories). Back it up
with the service stopped, or use SQLite's online backup:

```bash
sudo -u tesseract sqlite3 /opt/tesseract/app/data/tesseract.db \
  ".backup '/opt/tesseract/backups/tesseract-$(date +%F).db'"
```

A nightly cron entry that keeps 14 days is enough. `.env.local` should be
backed up separately, somewhere access-controlled — it holds your API key.

If you enabled pgvector (step 4), that database is **not** covered by the
above — add the `pg_dump` from that section to the same nightly job.

---

## When something goes wrong

**`npm ci` fails compiling better-sqlite3**
`build-essential` or `python3` is missing. Install both and retry.

**Service will not start**
`sudo journalctl -u tesseract -n 50 --no-pager`. Nearly always a missing or
malformed `.env.local`.

**Every answer errors with "credit balance is too low"**
The Anthropic account is out of credit. Top it up at console.anthropic.com;
nothing needs redeploying.

**First question after a restart takes ~10 seconds**
Expected. The local embedding model loads on first use and is then cached in
memory. Set `TRANSFORMERS_CACHE` to a path outside `node_modules` so `npm ci`
does not force a re-download on every upgrade.

**Large uploads are rejected**
`LimitRequestBody` in the Apache virtual host is too low — see step 11.

**Answers arrive in one lump after a long wait**
`flushpackets=on` is missing from the `ProxyPass` line, or compression is
re-enabled and buffering the stream. Both are in step 11.

**Requests die at exactly 60 seconds**
Apache's default `ProxyTimeout`. Set it to 600 as shown in step 11 — long
ingestions and long answers both exceed a minute.

**Invite links come out as http:// on an https:// site**
Certbot's generated `tesseract-le-ssl.conf` still carries
`RequestHeader set X-Forwarded-Proto "http"`. Change it to `https` and reload.

**502 Proxy Error from Apache**
The app is not running or not listening on 3005.
`sudo systemctl status tesseract`, then `sudo journalctl -u tesseract -n 50`.

---

## Appendix: putting Apache in front

**You do not need this.** The app serves HTTPS on 3005 by itself. Use this
only if policy requires everything behind the standard web server, or you want
it on 443 without giving Node a privileged port.

If you do, let Apache own TLS and have the app speak plain HTTP behind it:
remove `TLS_CERT_PATH` and `TLS_KEY_PATH` from `.env.local`, set
`APP_URL=https://tesseract.cubesmart.com`, and restart. Leaving TLS on in both
places means Apache would have to proxy over HTTPS to a self-signed backend,
which needs `SSLProxyEngine` and verification switches — more moving parts
than it is worth.

### Install and enable the modules

```bash
sudo apt install -y apache2
sudo a2enmod proxy proxy_http headers ssl rewrite
sudo systemctl restart apache2
```

`proxy` and `proxy_http` do the reverse proxying, `headers` sets
`X-Forwarded-Proto` so the app builds correct links, and `ssl` is needed
before certbot can install a certificate.

### The virtual host

```bash
sudo nano /etc/apache2/sites-available/tesseract.conf
```

```apache
<VirtualHost *:80>
    ServerName tesseract.cubesmart.com

    # Repository and folder uploads are large. Apache's default is unlimited,
    # but set it explicitly so the limit is a decision, not an accident.
    LimitRequestBody 536870912

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "http"

    # flushpackets=on forwards each chunk as it arrives instead of buffering
    # the response. Answers stream token by token, so without it they land in
    # one lump after a long silence.
    ProxyPass        / http://127.0.0.1:3005/ flushpackets=on timeout=600
    ProxyPassReverse / http://127.0.0.1:3005/

    # Compression buffers the stream and defeats the above.
    SetEnv no-gzip 1
    <Location />
        SetEnvIfNoCase Content-Type text/event-stream no-gzip=1
    </Location>

    ErrorLog  ${APACHE_LOG_DIR}/tesseract-error.log
    CustomLog ${APACHE_LOG_DIR}/tesseract-access.log combined
</VirtualHost>
```

Long ingestions and long answers both outlive Apache's 60-second default, so
raise the proxy timeout globally too:

```bash
echo "ProxyTimeout 600" | sudo tee /etc/apache2/conf-available/tesseract-timeout.conf
sudo a2enconf tesseract-timeout
```

Enable the site and drop the Ubuntu placeholder:

```bash
sudo a2ensite tesseract
sudo a2dissite 000-default
sudo apache2ctl configtest        # expect: Syntax OK
sudo systemctl reload apache2
```

### Add the certificate

```bash
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d tesseract.cubesmart.com
```

Certbot writes `tesseract-le-ssl.conf`, adds the HTTP→HTTPS redirect, and
installs a renewal timer. **One thing it does not do:** the new TLS virtual
host is a copy, so re-check that `RequestHeader set X-Forwarded-Proto` reads
`"https"` in it. If it still says `http`, invite links and redirects come out
as insecure URLs:

```bash
sudo nano /etc/apache2/sites-available/tesseract-le-ssl.conf
# RequestHeader set X-Forwarded-Proto "https"
sudo systemctl reload apache2
```

### Close the app port

Apache should be the only way in:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Apache Full'
sudo ufw enable
```

`Apache Full` opens 80 and 443. Port 3005 is then reachable only from the machine itself.

---
