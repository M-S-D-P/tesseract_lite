# Installing Tesseract Lite on Ubuntu

Written for Ubuntu 22.04 LTS and 24.04 LTS. Every command is run as a user
with `sudo`. Total time: about 20 minutes, most of it waiting on `npm ci`.

The result: the app running under systemd as a dedicated service account,
behind nginx with HTTPS, starting automatically on reboot.

---

## 1. What you need before you start

| Thing | Why | Where it comes from |
|---|---|---|
| Ubuntu server, 2 vCPU / 4 GB RAM minimum | 4 GB is comfortable; the local embedder is the memory-hungry part | your infrastructure team |
| An Anthropic API key with credit | every answer is a Claude call | console.anthropic.com → API keys |
| A hostname pointing at the server | e.g. `tesseract.cubesmart.com` | your DNS team |
| GitHub token (optional) | only for **private** repositories | github.com → Settings → Developer settings |

Disk: 20 GB is plenty for the app and a few large repositories. Indexing a
very large codebase is the main consumer.

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

## 3. Create the service account and directory

Running a web app as `root` or as a person's login is a bad habit. Give it its
own unprivileged account:

```bash
sudo useradd --system --create-home --home-dir /opt/tesseract --shell /usr/sbin/nologin tesseract
```

---

## 4. Get the code

```bash
sudo -u tesseract git clone https://github.com/M-S-D-P/tesseract_lite.git /opt/tesseract/app
cd /opt/tesseract/app
```

For a private repository, clone with a token or deploy key:

```bash
sudo -u tesseract git clone https://<TOKEN>@github.com/M-S-D-P/tesseract_lite.git /opt/tesseract/app
```

---

## 5. Configure

```bash
sudo -u tesseract cp .env.example .env.local
sudo -u tesseract nano .env.local
```

Fill in three values:

```ini
ANTHROPIC_API_KEY=sk-ant-...
AUTH_SECRET=<paste the output of: openssl rand -base64 48>
APP_URL=https://tesseract.cubesmart.com
```

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

## 6. Install and build

```bash
cd /opt/tesseract/app
sudo -u tesseract npm ci
sudo -u tesseract npm run build
```

`npm ci` takes a few minutes and compiles `better-sqlite3`. The build prints a
route table when it succeeds.

---

## 7. Create the accounts

```bash
sudo -u tesseract npm run seed
```

This creates the **CubeSmart** organization, the administrator account, and
the fifteen member accounts, then prints a password for each one and writes
them to `data/seed-credentials.txt` (readable only by the service account).

**Copy those passwords out now, distribute them, and delete the file:**

```bash
sudo -u tesseract cat data/seed-credentials.txt
sudo -u tesseract rm data/seed-credentials.txt
```

Re-running `npm run seed` later is safe: it adds only missing accounts and
never changes an existing password.

---

## 8. Run it under systemd

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
Environment=PORT=3002
ExecStart=/usr/bin/npm run start
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

It should report `active (running)`. Confirm it answers:

```bash
curl -I http://localhost:3002/login     # expect HTTP/1.1 200 OK
```

---

## 9. Put nginx in front with HTTPS

```bash
sudo apt install -y nginx
sudo nano /etc/nginx/sites-available/tesseract
```

```nginx
server {
    listen 80;
    server_name tesseract.cubesmart.com;

    # Repository and folder uploads are large; the default 1 MB will reject them.
    client_max_body_size 512M;

    location / {
        proxy_pass         http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Answers stream token by token — buffering makes them arrive all at
        # once after a long pause, and long ingestions look like timeouts.
        proxy_buffering    off;
        proxy_read_timeout 600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tesseract /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Add the certificate:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d tesseract.cubesmart.com
```

Certbot rewrites the config for TLS and installs a renewal timer.

Finally, close the app port to the outside world so nginx is the only way in:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

## 10. First login

Open `https://tesseract.cubesmart.com` and sign in as
`smallela@cubesmart.com` with the password from step 7.

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

**Uploads fail at around 1 MB**
`client_max_body_size` is missing from the nginx config — see step 9.

**Answers arrive in one lump after a long wait**
`proxy_buffering off;` is missing from the nginx config.
