# Tesla Powerwall Scheduler

A local web app (macOS) that automates your Powerwall settings through Tesla's
Fleet API. You define a daily schedule — backup reserve, operating mode, energy
exports, and grid charging — and the app applies it at the right times, **reads
the setting back to confirm it actually took**, and retries if it didn't.

It also reports on what your schedule is doing for your electric bill: time‑of‑use
cost breakdowns, a peak‑window audit, and a solar‑savings estimate against your
actual PG&E bill.

> **Heads up:** This software changes the **backup reserve** on your home
> battery — the energy held back for outages. You are responsible for keeping
> that reserve aligned with your own risk tolerance. See **Disclaimer** below.

---

## Features

- **Schedules** — multiple named schedules (e.g. Summer / Winter); one is active.
  Each row sets backup reserve %, operating mode (Self‑Powered / Time‑Based
  Control), energy exports, and grid charging at a specific time of day.
- **Apply + verify** — when a scheduled time hits, the app POSTs the settings,
  waits for the gateway to settle, reads `site_info` back, and retries the
  fields that didn't apply. No more silent "it said 200 but nothing changed."
- **Net Billing** report — grid import/export/net kWh by day and time window.
- **TOU Cost** report — your grid usage priced against your time‑of‑use rate
  plan, with a peak‑window audit (did the battery carry the 4–9 PM peak?).
- **Solar Savings** report — prices your *total home usage* as if you had no
  solar/battery, subtracts what you actually paid, and estimates your savings.
  Exports to CSV for Google Sheets.
- **Settings** — live gateway state and the rate schedule Tesla has on file.
- **Rates** — optionally override the rate plan when Tesla's data is incomplete.
- **Configure** — choose who can reach the app (localhost / LAN / public),
  set a password, port, and timezone.
- **Activity** — merged, filterable log of every scheduled run and server event.

---

## Requirements

- **macOS** (uses `launchd` for scheduling and an always‑on server).
- **Node.js 20+** (`node --version`).
- A **Powerwall** (or Solar + Powerwall) on your Tesla account.
- A **domain you control with HTTPS** — Tesla's Fleet API requires you to host a
  public key at a well‑known URL on your own domain. (A static host like GitHub
  Pages, Netlify, or an S3 bucket behind CloudFront works; it just needs HTTPS.)

This is a personal, single‑household tool. It is not a hosted service.

---

## Part 1 — Tesla Fleet API setup (the involved part)

Tesla's Fleet API requires you to register as a third‑party developer and prove
control of a domain. Budget 30–60 minutes the first time.

### 1. Create a developer app

1. Sign in at <https://developer.tesla.com> and create an application.
2. Request these OAuth scopes:
   ```
   openid offline_access energy_device_data energy_cmds
   ```
3. Note your **Client ID** and **Client Secret**.
4. Add this **Allowed Redirect URI**:
   ```
   http://localhost:8787/auth/callback
   ```
   If Tesla's portal rejects a non‑HTTPS redirect URI, use an HTTPS tunnel
   (see *Tailscale* / Cloudflare Tunnel / ngrok below) and register that
   callback URL instead — then put the same URL in the app's connection
   settings.

### 2. Generate your key pair

From the repo directory:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
openssl ec -in private-key.pem -pubout -out public-key.pem
```

- **Keep `private-key.pem` secret.** It is gitignored and must never be committed.
- You'll host `public-key.pem` publicly in the next step.

### 3. Host the public key on your domain

Tesla checks for the public key at this exact path on the domain you registered:

```
https://YOUR_DOMAIN/.well-known/appspecific/com.tesla.3p.public-key.pem
```

Upload `public-key.pem` to that URL. Confirm it loads in a browser before
continuing.

### 4. Register your partner account

Put your values in `.env` (copy the template first):

```bash
cp .env.example .env
```

```
TESLA_CLIENT_ID=your-client-id
TESLA_CLIENT_SECRET=your-client-secret
TESLA_APP_DOMAIN=your-domain.com
TESLA_REGION=na          # na | eu | cn
```

Then register (run once per region you use):

```bash
npm run register             # uses TESLA_REGION
npm run register -- --region na
```

A successful run prints your partner account and confirms Tesla can read your
hosted public key.

---

## Part 2 — Run the app

```bash
npm install        # no third-party deps today, but safe to run
npm run check      # syntax-checks the source
npm start          # starts the server on http://localhost:8787
```

Open <http://localhost:8787> and:

1. **Connect Tesla** — completes the OAuth login and stores your tokens locally
   in `config/tokens.json` (gitignored).
2. **Discover Sites** — finds your energy site and saves its ID.
3. On a schedule row, click **Dry Run** to see the exact payloads, then **Run
   Now** once you're comfortable.

---

## Using it

### Schedules

Each row applies four settings at its time:

| Field | Options | Meaning |
|---|---|---|
| Backup Reserve | 0–100% | Energy held back for outages; the battery won't discharge below this. |
| Operating Mode | Self‑Powered / Time‑Based Control | *Self‑Powered* always serves load from the battery. *Time‑Based Control* lets Tesla cost‑optimize against your rate plan (it may pull cheap grid power instead of discharging). |
| Energy Exports | Solar Only / Everything / None | What may be exported to the grid. |
| Grid Charging | On / Off | Whether the battery may charge from the grid. |

Multiple schedules (e.g. Summer/Winter) live under one config; **Activate** the
one you want. Only the active schedule runs. Switch seasons manually.

When you **Save**, the app installs one `launchd` job per enabled row (fired one
minute past the row's time) and removes jobs for rows you deleted. The save
status shows what changed (`+1 added, ~1 updated, -1 removed`).

### How scheduled runs work

Each per‑time `launchd` job runs `scripts/run-due.mjs --step <id>`, which:

1. POSTs the row's backup / operation / grid‑import‑export settings.
2. Waits ~45 s for the gateway to settle.
3. Reads `site_info` back and compares all four fields.
4. Re‑POSTs only the fields that didn't match, waits, re‑checks — up to 3 tries.
5. Logs `step_verified` on success or `verify_failed` (with the mismatched
   fields) on exhaustion.

Each job writes to its own log: `logs/run-<HHMM>.log`. The **Activity** tab
merges these with server events and lets you filter by source.

### Reports

- **Net Billing** — kWh in/out/net by day and time bucket.
- **TOU Cost** — grid usage priced at your TOU rates; flags any day with
  peak‑hour grid imports and shows battery state of charge across the peak.
- **Solar Savings** — total home usage priced as if grid‑only (no solar/battery)
  minus your actual bill = estimated savings. Enter your billing period and the
  amount billed. **Download CSV** for Google Sheets.

### Rate plan (Settings + Rates)

The app prices reports using the rate plan Tesla has on file (visible in
**Settings**). If that plan is missing periods (e.g. partial‑peak windows your
utility actually has), open **Rates**, enable **Use custom rates**, and define
seasons and periods yourself. Custom rates override Tesla's for report math
only — they don't change what the Powerwall does.

---

## Run in the background

Install the always‑on server as a `launchd` agent so it starts at login and
restarts itself if it crashes or after the Mac wakes:

```bash
zsh scripts/install-launchd.zsh
```

Restart it after a code change:

```bash
zsh scripts/restart.zsh
```

Uninstall it (and its scheduled jobs):

```bash
zsh scripts/uninstall-launchd.zsh
```

The Mac must be awake and online when a scheduled change is due. `launchd`'s
calendar jobs will wake the Mac to fire them, but if the Mac is fully shut down
a scheduled change is missed.

---

## Access & security (Configure tab)

By default the server binds to **localhost** — reachable only from the Mac it
runs on, no password. The **Configure** tab lets you change that:

| Mode | Binds to | Reachable by | Password |
|---|---|---|---|
| **Localhost** (default) | `127.0.0.1` | this Mac only | not needed |
| **Local network** | `0.0.0.0` | devices on your Wi‑Fi/LAN | recommended |
| **Public** | `0.0.0.0` | beyond your network *via a tunnel you run* | **required** |

- A password (stored salted+hashed; checked via HTTP Basic Auth) protects every
  request when set.
- **"Public" only changes the bind** — it does not open your router. You must
  put the app behind an HTTPS tunnel or reverse proxy. **Never port‑forward
  plain HTTP**; the Basic Auth password would travel unencrypted.
- Changing access mode / port restarts the server (the LaunchAgent respawns it).

### Recommended: remote access with Tailscale

For getting to the app while away (e.g. on vacation), **don't expose it to the
public internet.** Use [Tailscale](https://tailscale.com) — a private mesh VPN.
Your devices join a private network; nothing is published publicly.

1. **Install on the Mac** (the one running the scheduler):
   ```bash
   brew install --cask tailscale
   ```
   Launch Tailscale and sign in. (Or use the Mac App Store version.)
2. **Install Tailscale on your phone/laptop** and sign in to the **same account**.
3. **Find the Mac's Tailscale address:**
   ```bash
   /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
   ```
   It looks like `100.x.y.z`. (Or use the MagicDNS name shown in the Tailscale
   admin console, e.g. `your-mac.tailnet-name.ts.net`.)
4. **In the app's Configure tab**, choose **Local network** and **set a
   password**, then Save & Restart. (LAN bind covers the Tailscale interface.)
5. **From your phone**, while connected to Tailscale, open:
   ```
   http://100.x.y.z:8787
   ```
   and enter the password.

**Optional — HTTPS via Tailscale Serve** (encrypts the password in transit and
gives a clean hostname):

```bash
tailscale serve --bg 8787
```

This publishes `https://your-mac.tailnet-name.ts.net/` to your tailnet with a
valid certificate, proxying to the local app. Access that HTTPS URL from any of
your Tailscale devices. (Requires HTTPS enabled for your tailnet in the admin
console.)

Tailscale gives you encrypted remote access with **no public exposure** — far
safer than "Public" mode + port forwarding.

---

## Configuration files

All gitignored (never committed):

| File | Contents |
|---|---|
| `.env` | Tesla client ID/secret, domain, region, port |
| `config/local-settings.json` | site ID, credentials, access mode + hashed password, rate override |
| `config/schedule.json` | your active schedules |
| `config/tokens.json` | Tesla OAuth access/refresh tokens |
| `private-key.pem` / `*.pem` | your key pair |
| `logs/` | run + server logs |

Templates `config/default-schedule.json` and `.env.example` are committed; real
values are created locally on first run.

---

## Tesla API reference

Endpoints used:

- `GET /api/1/products`
- `GET /api/1/energy_sites/{id}/site_info`
- `GET /api/1/energy_sites/{id}/live_status`
- `GET /api/1/energy_sites/{id}/calendar_history` (energy + soe, for reports)
- `POST /api/1/energy_sites/{id}/backup`
- `POST /api/1/energy_sites/{id}/operation`
- `POST /api/1/energy_sites/{id}/grid_import_export`

Official docs: <https://developer.tesla.com/docs/fleet-api>

The Fleet API may reject settings your utility, tariff, account, or firmware
doesn't allow. Every response is kept in the Activity log so failures are easy
to spot.

---

## Disclaimer

This software is provided "as is," without warranty of any kind (see `LICENSE`).
It changes real settings on your home battery, including the **backup reserve**
that protects you during outages. You are solely responsible for the settings
you schedule and their consequences. The savings reports are **estimates** — a
home without solar would likely be on a different rate plan, and fixed charges,
minimums, and true‑up are not modeled. Verify against your actual utility bills.

Not affiliated with, endorsed by, or supported by Tesla, Inc. "Tesla" and
"Powerwall" are trademarks of Tesla, Inc.
