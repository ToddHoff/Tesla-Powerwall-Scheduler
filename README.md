# Tesla Powerwall Scheduler

A local web app (macOS / Linux) that automates your Powerwall settings through Tesla's
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

<img width="1000" height="744" alt="Image" src="https://github.com/user-attachments/assets/82507d00-db59-4c33-92a4-571dd2192f21" />

---

<img width="1000" height="744" alt="Image" src="https://github.com/user-attachments/assets/00a8673c-c58d-431a-a4f4-d092697cfd1b" />

## Features

- **Schedules** — multiple named schedules (e.g. Summer / Winter); one is active.
  Each row sets backup reserve %, operating mode (Self‑Powered / Time‑Based
  Control), energy exports, and grid charging at a specific time of day.
- **Apply + verify** — when a scheduled time hits, the app POSTs the settings,
  waits for the gateway to settle, reads `site_info` back, and retries the
  fields that didn't apply. No more silent "it said 200 but nothing changed."
- **Insights** report — rules-based analyzers run over the last 14 days of
  your data and surface specific, dollar-quantified opportunities (e.g.
  *"Morning load is pulling from the grid at $0.32/kWh; a Self‑Powered step
  at 7 AM saves ~$13/month"*). Includes a ready‑to‑paste prompt for ChatGPT /
  Claude / Gemini if you want a second opinion — no API key required.
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

- **macOS** (developed and tested here). macOS uses `launchd` per-user agents.
- **Linux** *should* work — the cron backend is platform-portable — but
  has **not been tested**. See [Linux (untested)](#linux-untested) below.
- **Windows** is **not supported** as-is; you'd run it under WSL2. See
  [Windows (untested)](#windows-untested) below.
- **Node.js 20+** (`node --version`).
- A computer that **stays on 24/7**. Neither launchd nor cron runs (or wakes
  the machine) while it's asleep, so a sleeping or shut-down machine misses
  scheduled changes. See
  [The computer must be ALWAYS ON](#️-the-computer-must-be-always-on).
- A **Powerwall** (or Solar + Powerwall) on your Tesla account.
- A **domain you control with HTTPS** — Tesla's Fleet API requires you to host a
  public key at a well‑known URL on your own domain. (A static host like GitHub
  Pages, Netlify, or an S3 bucket behind CloudFront works; it just needs HTTPS.)

This is a personal, single‑household tool. It is not a hosted service.

---

## Get the code

Clone the repo from GitHub:

```bash
git clone https://github.com/ToddHoff/Tesla-Powerwall-Scheduler.git
cd Tesla-Powerwall-Scheduler
```

You'll run every command in the rest of the setup from this directory.

(If you don't have `git`: on macOS install via Xcode Command Line Tools —
`xcode-select --install` — or download a ZIP from the GitHub page and unzip
it.)

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

Put your values in a `.env` file **in the repo root** (the same directory as
`server.mjs` and `package.json` — *not* inside `config/` or `scripts/`). Copy
the template first:

```bash
cd /path/to/this/repo   # the directory you cloned into
cp .env.example .env    # creates ./.env next to package.json
```

Then edit `.env`:

```
TESLA_CLIENT_ID=your-client-id
TESLA_CLIENT_SECRET=your-client-secret
TESLA_APP_DOMAIN=your-domain.com
TESLA_REGION=na          # na | eu | cn
```

`.env` is gitignored, so it never gets committed.

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

Then open <http://localhost:8787> in any browser. See the next section for
what to do once it's open and how to reach it from other devices.

---

## Using it from the web

The whole app is a normal web page running on the machine that you ran
`npm start` (or `scripts/restart.sh`) on. Open it in any browser. **Which URL
to use depends on the Access mode** (set in the *Configure* tab — defaults to
Localhost):

| Access mode | URL to open | Reachable from |
|---|---|---|
| **Localhost** (default) | `http://localhost:8787` <br>or `http://127.0.0.1:8787` | only the machine running the server |
| **Local network** | `http://<your-machine's-LAN-IP>:8787` <br>(localhost still works on the host itself) | any device on the same Wi-Fi/LAN |
| **Tailscale** (recommended for remote) | `http://<tailscale-IP>:8787` <br>or `http://<machine-name>:8787` (MagicDNS) <br>or `https://<machine-name>.<tailnet>.ts.net/` (Tailscale Serve) | any device signed into your tailnet |
| **Public** | the URL of the tunnel/reverse proxy you set up | the public internet, **with a password** |

If a password is set (any mode except localhost should have one), the browser
prompts for both a **username** and a **password** via HTTP Basic Auth.

- **Username:** type `admin`. (The server doesn't actually check the username
  field — it only validates the password. `admin` is just a convention so the
  prompt isn't confusing.)
- **Password:** the one you set in **Configure** → Password.

Most browsers will remember the credentials per host, so you usually won't be
asked again until you clear site data or open a private window.

### Finding the URL for your machine

- **Your Mac's LAN IP:** System Settings → Network → click your active
  connection → it's shown there. Or in a terminal:
  ```bash
  ipconfig getifaddr en0   # Wi-Fi (try en1 if that's empty)
  ```
- **Your Mac's Tailscale IP / name:** in Terminal:
  ```bash
  tailscale ip -4              # e.g. 100.x.y.z
  tailscale status | head -1   # shows the MagicDNS name
  ```
- **Linux:** `hostname -I` for the LAN IP; `tailscale ip -4` same as above.

The Configure tab also shows the **LAN IP and the URL it expects to be reached
at** for the current mode — easiest place to copy it from.

### What you'll see — quick tour of the tabs

- **Schedules** — view / edit / save the schedule that fires automatically.
  Click **Save** to install (or update) the scheduled jobs at the OS level.
- **Reports** — a parent tab with four sub-tabs:
  - **Insights** — rules-based recommendations with dollar estimates and a
    copy-paste prompt for an external AI.
  - **Net Billing** — kWh in / out / net by day and time bucket.
  - **TOU Cost** — grid usage priced at your TOU rates.
  - **Solar Savings** — no-solar hypothetical bill vs. your actual PG&E bill.
- **Settings** — what the Powerwall is doing right now, the rate plan in
  effect, and the **Scheduled jobs** panel that shows exactly which jobs the
  OS scheduler has installed (verify Save worked).
- **Rates** — override the rate plan when Tesla's tariff is incomplete.
- **Configure** — change access mode (Localhost / LAN / Public), set a
  password, port, timezone. Save & Restart applies it.
- **Activity** — merged log of scheduled runs and server events, filterable
  by source.

### First-time flow

1. On the **Schedules** tab, fill in your **Tesla Connection** values
   (region, client ID/secret, redirect URI, energy site ID — though
   *Discover Sites* will populate the site ID for you).
2. Click **Connect Tesla** → log in at Tesla → it redirects back and stores
   your tokens locally.
3. Click **Discover Sites** → confirm the right energy site.
4. Edit a schedule row, click **Dry Run** to see the exact payloads, then
   **Run Now** once you're comfortable.
5. Click **Save** to install the scheduled jobs. Open **Settings** → scroll to
   **Scheduled jobs** to verify they're installed in launchd / cron.

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

When you **Save**, the app installs one scheduled job per enabled row, fired
one minute past the row's time, and removes jobs for rows you deleted. The save
status shows the scheduled times.

**The scheduler used depends on the OS:**

| OS | Backend | Job files |
|---|---|---|
| **macOS** | `launchd` per-user agents | `~/Library/LaunchAgents/powerwall-scheduler.step.<HHMM>.plist` |
| **Linux** | `cron` | a marked block in your user `crontab` |

The split is automatic (chosen by `process.platform`). It exists because macOS
treats a Terminal-launched process modifying the crontab as "administering the
computer" and pops up an authorization prompt on every change — launchd has no
such prompt and is the native scheduler on macOS anyway. The Linux side uses
cron because it's universally available and prompt-free there.

> On Linux the app only touches the lines between its own
> `# >>> powerwall-scheduler >>>` markers in your crontab, leaving any other
> cron entries alone. It only rewrites the block when the step *times* actually
> change, not on every save.

### How scheduled runs work

Each scheduled job runs `scripts/run-due.mjs --step <id>`, which:

1. POSTs the row's backup / operation / grid‑import‑export settings.
2. Waits ~45 s for the gateway to settle.
3. Reads `site_info` back and compares all four fields.
4. Re‑POSTs only the fields that didn't match, waits, re‑checks — up to 3 tries.
5. Logs `step_verified` on success or `verify_failed` (with the mismatched
   fields) on exhaustion.

Each job writes to its own log: `logs/run-<HHMM>.log`. The **Activity** tab
merges these with server events and lets you filter by source.

### Reports

The Reports tab has four sub-tabs:

- **Insights** — runs a fixed set of rules-based analyzers against the last
  14 days of your data and surfaces specific, dollar-quantified
  recommendations as cards. Each card has a title, an estimated `$X/month`
  saving, a one-line summary, a concrete recommendation, and an expandable
  `▶ details` block with the raw numbers. Current analyzers:
  - `peak-grid-imports` — flags $ spent on grid during the 4–9 PM peak.
  - `partial-peak-imports` — flags $ spent during the 3–4 PM and 9 PM–midnight
    partial-peak windows.
  - `mode-mismatch-mornings` — flags morning load (6 AM–noon) pulling from the
    grid when Self-Powered would have used the battery.
  - `reserve-floor-breach` — flags days the battery hit its reserve floor
    before 9 PM, costing peak imports.
  - `unproductive-grid-charging` — flags overnight grid-charging on days when
    solar later exported more than was bought, suggesting the grid charge was
    unnecessary.

  Below the cards is a **"Prompt for an external AI"** textarea — a complete,
  ready-to-paste prompt containing your rate plan, active schedule, current
  Powerwall settings, 14-day usage aggregates, hourly load profile, and the
  rules-based findings. A **Copy** button puts it on the clipboard so you can
  paste into ChatGPT / Claude / Gemini for additional analysis without writing
  a single line of context. The app itself makes no outbound LLM calls — your
  data stays local unless you choose to paste it.

  > **Why 14 days, not 30?** The Insights endpoint calls Tesla's
  > `calendar_history` once per day in the window. Tesla rate-limits these
  > calls; 30 sequential requests trip the limit. 14 is enough signal for
  > the analyzers and stays comfortably under the budget. If you want a
  > longer window, server-side caching (1-hour TTL) is a natural follow-up.

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

## Running it

Scheduled battery changes are fired by the OS scheduler (launchd on macOS,
cron on Linux) and need nothing running in the background — each scheduled job
invokes `scripts/run-due.mjs` directly at its time. The server is only for the
**web UI and reports**.

Start (or restart) the server in the background:

```bash
scripts/restart.sh
```

It backgrounds `node server.mjs`, logging to `logs/server.out.log`. Run
`npm start` instead if you'd rather keep it in the foreground.

The server is **not supervised** — if it crashes, just run `scripts/restart.sh`
again. The schedule keeps running regardless of whether the server is up.

To have the server come back automatically after a reboot:

- **Linux:** add an `@reboot` line to your crontab:
  ```
  @reboot cd /path/to/repo && node server.mjs >> logs/server.out.log 2>&1
  ```
- **macOS:** install a supervised LaunchAgent that auto-starts at login and
  respawns the server if it crashes:
  ```bash
  zsh scripts/install-launchd.zsh    # installs ~/Library/LaunchAgents/powerwall-scheduler.plist
  zsh scripts/restart.zsh            # restart via launchctl kickstart (after install)
  zsh scripts/uninstall-launchd.zsh  # remove agent + per-step jobs
  ```
  Or skip the LaunchAgent and just run `scripts/restart.sh` from Terminal at
  login.

To remove the scheduled jobs entirely, clear them from the UI by disabling all
rows and saving — the app cleans up the per-OS scheduler state. (On Linux you
can also edit your crontab `crontab -e` and delete the
`# >>> powerwall-scheduler >>>` … `# <<<` block by hand; on macOS, remove the
`~/Library/LaunchAgents/powerwall-scheduler.step.*.plist` files.)

### ⚠️ The computer must be ALWAYS ON

**This is the single most important requirement.** Neither launchd (macOS) nor
cron (Linux) runs while the machine is asleep, and neither wakes it for a job —
a missed time is simply skipped. (launchd does run a calendar job *once* on
wake if it was missed, but the setting would arrive late — possibly hours
late — which for "off-peak begins at midnight" is worse than skipping.) Either
way, if your Mac sleeps at midnight, the midnight battery change never happens
on time. So the computer running this **must stay awake 24/7** (the display
can sleep — only *system* sleep matters), and stay connected to the network.

Best option: run it on a **dedicated always-on machine** — a Mac mini, an old
laptop left plugged in, a Linux mini-PC, or a Raspberry Pi. Don't use a laptop
you carry around and close the lid on.

**Keep a Mac awake**
- System Settings → **Battery** (or **Energy Saver** on desktops / when plugged
  in) → turn **off** "Put hard disks to sleep" and set the sleep timer so the
  computer never sleeps. On laptops, also enable "Prevent automatic sleeping
  when the display is off" / keep it plugged in.
- A laptop still sleeps when you **close the lid**. To prevent that you need an
  external display/keyboard (clamshell) or a tool like Amphetamine (Mac App
  Store). For a quick test you can run `caffeinate -s` in a terminal, but that
  only lasts until you close the terminal — it's not a permanent solution.
- Verify with `pmset -g` (look at `sleep` — it should be `0`). To force it:
  `sudo pmset -a sleep 0 disksleep 0` (display sleep is fine to leave on).

**Keep a Linux machine awake**
- Servers/Pis are normally always-on already. To be sure nothing suspends it:
  `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`
- On a laptop, stop it suspending when the lid closes — set
  `HandleLidSwitch=ignore` in `/etc/systemd/logind.conf`, then
  `sudo systemctl restart systemd-logind`.

**Either way:** also set the **server** to come back after a reboot — on Linux
add the `@reboot` crontab line above; on macOS, run `scripts/restart.sh` from a
Terminal login item (System Settings → General → Login Items) or wrap it in
your own LaunchAgent.

---

## Linux (untested)

> **This has never been run or tested on Linux.** It's built and used on
> macOS. The Linux scheduling backend (cron) and the server itself are written
> to be portable — no native dependencies, only standard `node`, `bash`, and
> `crontab` — so it *should* work on a typical Linux box / Raspberry Pi
> without changes. But nobody has actually run it there yet. Expect rough
> edges, especially around:
>
> - Whether `cron` is installed and running by default on your distro (on
>   minimal Debian/Ubuntu and most Pi images it is; on Alpine you'd install
>   `cronie` or `dcron`).
> - Whether your `cron` daemon picks up changes to the user crontab without a
>   restart (most do; some need `sudo service cron reload`).
> - File paths and Node binary location embedded in the cron lines
>   (`process.execPath` at the time of Save) — if you upgrade Node these may
>   need a re-save.
>
> If you try it and hit something, the fix is usually small. Reports / PRs
> welcome.

---

## Windows (untested)

> **This has never been run or tested on Windows.** It's built and used on
> macOS, and should work on Linux. The notes below are a best-effort starting
> point, not a supported path — expect to do some debugging.

**Native Windows won't work as-is.** Two things depend on a Unix environment:
- Scheduling shells out to `cron`, which Windows doesn't have — so saving a
  schedule would fail and nothing would run automatically. (A Windows port
  would use Task Scheduler / `schtasks` instead.)
- The server's self-restart and `scripts/restart.sh` assume `/bin/sh` and bash.

**Recommended path: WSL2** (Windows Subsystem for Linux). Inside a WSL2 Linux
distro the app runs like it does on Linux — Node, cron, and bash all work:

1. Install WSL2 and a distro: `wsl --install` (PowerShell, as admin), reboot.
2. In the WSL shell, install Node 20+, clone the repo, and follow the macOS/Linux
   setup above.
3. Start cron (it isn't on by default in WSL): `sudo service cron start`. To make
   it survive reboots you'll need systemd enabled in WSL, or a Windows Task
   Scheduler entry that launches the distro at logon.
4. Keep Windows awake (see the always-on section) — WSL2 only runs while Windows
   is up and the distro is running.
5. For LAN/remote access, `localhost` works inside Windows, but reaching the app
   from *other* devices requires a Windows-side port proxy
   (`netsh interface portproxy add v4tov4 listenport=8787 connectaddress=<wsl-ip> connectport=8787`),
   because WSL2 sits behind a virtual NAT.

If someone wants a clean native-Windows version (a `schtasks` scheduler backend
plus a non-bash start script), the Tesla/report/UI code is already platform-
neutral — only the scheduling and restart glue would need a Windows variant.
PRs welcome.

---

## Network access (Configure tab)

By default the server binds to **localhost** — reachable only from the machine
it runs on, no password. The **Configure** tab lets you change that:

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
- Changing access mode / port restarts the server (it respawns itself).

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

## Security

This is a personal, self-hosted tool. It runs entirely on your own machine and
talks to exactly one external service — **Tesla's Fleet API**. There is no cloud
backend, no telemetry, and no analytics: nothing about your home, energy usage,
or credentials is sent anywhere except Tesla.

**Your secrets stay local.**
- Tesla OAuth tokens (`config/tokens.json`), your API client ID/secret (`.env`,
  `config/local-settings.json`), and your signing key (`private-key.pem`) exist
  only on disk on your machine. All are gitignored (see *Configuration files*)
  and never committed or sent to any third party.
- Your Tesla **account password is never stored** — auth is OAuth, so the app
  only ever holds scoped tokens, which you can revoke at any time (below).

**Blast radius — what a compromise could and couldn't do.**
- The OAuth scopes granted are energy-only (`energy_device_data energy_cmds`).
  So the worst anyone reaching the app could do is **read your energy data and
  change your Powerwall settings** (backup reserve, mode, exports, grid
  charging). They **cannot** touch your vehicles, your Tesla account, your
  payment methods, or your password.
- In practice the worst case is someone draining your battery or changing your
  outage reserve. Bad, but bounded.

**Access control.**
- The server **binds to localhost by default** — not reachable from any other
  device. LAN and Public are explicit opt-ins (see *Network access*).
- When you set a password it protects **every** request (HTTP Basic Auth). It's
  stored **salted and hashed with scrypt** — never plaintext, never in git — and
  compared in constant time.
- **Public mode requires a password**; the server refuses to come up in public
  mode without one and falls back to localhost.

**Honest limitations — please read.**
- HTTP Basic Auth sends the password Base64-encoded, which is **not
  encryption**. Over plain HTTP anyone on the network path can read it. A
  password is therefore only meaningful on a **trusted LAN** or **behind HTTPS**
  (a Tailscale / Cloudflare tunnel or reverse proxy). This is exactly why the
  recommended remote-access path is Tailscale, and why "Public over plain HTTP"
  is flagged as unsafe.
- The app is **not hardened for hostile multi-user networks**: no rate limiting,
  no CSRF protection, no per-user audit. It assumes a single trusted owner on a
  machine they control. **Treat the machine itself as the security boundary** —
  anyone with access to it, or to an unprotected open port, can control your
  Powerwall.

**Revoking access.** You can revoke this app's access anytime from your Tesla
account's third-party-apps settings; that invalidates the stored tokens
immediately. Do this if the machine is lost, shared, or decommissioned.

**Your responsibilities.**
- Keep the host machine secure and patched — it holds long-lived refresh tokens
  and can command your battery.
- Use a password for any access mode other than localhost.
- Before pushing to a public repo, confirm secrets are untracked (they're
  gitignored, but verify): `git status` should never list `.env`,
  `config/tokens.json`, `config/local-settings.json`, or `*.pem`.

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
