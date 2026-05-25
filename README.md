# Tesla Powerwall Scheduler

A local web app and scheduler for applying a June-September Powerwall automation schedule through Tesla's Fleet API.

## What It Does

- Runs a local web app at `http://localhost:8787`
- Stores your schedule in `config/schedule.json`
- Uses Tesla OAuth to get an access/refresh token
- Applies Powerwall settings at the configured times
- Keeps recent activity in `logs/scheduler.log`
- Can run as a macOS LaunchAgent so it starts when you log in

This replaces the NetZero-style scheduled changes for backup reserve, operational mode, energy exports, and grid charging.

## Quick Start

```bash
cd ~/tesla
cp .env.example .env
npm run check
npm start
```

Open `http://localhost:8787`.

## Tesla Setup

1. Create or sign in to a Tesla developer account at `https://developer.tesla.com`.
2. Create a Fleet API application.
3. Request these OAuth scopes:

   ```text
   openid offline_access energy_device_data energy_cmds
   ```

4. Generate a Tesla public/private key pair:

   ```bash
   cd ~/tesla
   openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
   openssl ec -in private-key.pem -pubout -out public-key.pem
   ```

5. Host `public-key.pem` on the domain you used in the Tesla developer portal at this exact URL:

   ```text
   https://YOUR_DOMAIN/.well-known/appspecific/com.tesla.3p.public-key.pem
   ```

   Keep `private-key.pem` private. Do not upload it.

6. Add this redirect URI to the Tesla app:

   ```text
   http://localhost:8787/auth/callback
   ```

   If Tesla's portal requires a public HTTPS redirect URI, use a temporary HTTPS tunnel such as Cloudflare Tunnel or ngrok and put that callback URL in both the Tesla app and this app's settings.

7. Put your Tesla application values in `.env`:

   ```text
   TESLA_CLIENT_ID=...
   TESLA_CLIENT_SECRET=...
   TESLA_APP_DOMAIN=your-domain.com
   ```

8. Register the app with Tesla after the public key URL is live:

   ```bash
   cd ~/tesla
   npm run register
   ```

   Run registration once for each region you need by passing `--region na`, `--region eu`, or `--region cn`.

9. Start this app and press **Connect Tesla**.
10. Press **Discover Sites** and select your Powerwall energy site.
11. Use **Dry Run** on a row first. Then use **Run Now** once you are comfortable with the payloads.

## Current Schedule

The default Summer schedule is already loaded:

| Time | Backup Reserve | Mode | Energy Exports | Grid Charging |
|---|---:|---|---|---|
| 7:00 AM | 30% | Self-Powered | Solar Only | Disabled |
| 3:00 PM | 30% | Time-Based Control | Solar Only | Disabled |
| 4:00 PM | 30% | Time-Based Control | Solar Only | Disabled |
| 9:05 PM | 30% | Time-Based Control | Solar Only | Disabled |
| 12:00 AM | 50% | Time-Based Control | Solar Only | Enabled |

The schedule only runs in June, July, August, and September by default.

## Summer And Winter Schedules

The UI stores multiple schedules in `config/schedule.json` under `schedules`, with one active schedule selected by `activeScheduleId`.

- **Summer** is active by default and uses June-September.
- **Winter** is included as a starter schedule for January-May and October-December.
- Press **Activate** on a schedule in the UI to make it the one used by Lingon, `npm run due`, and the local runner.

Only the active schedule runs automatically. You can still view, edit, dry-run, and save either schedule from the local UI.

## Run In The Background

### Lingon, Cron, Or Launchd At Specific Times

Use this command when an external scheduler wakes up at a specific time and should run only whatever is due right then:

```bash
cd ~/tesla
npm run due
```

Or call the wrapper directly:

```bash
/Users/toddhoff/tesla/scripts/run-due.zsh
```

That command starts, reads the current local time, runs any matching schedule row, writes `config/run-state.json` and `logs/scheduler.log`, then exits. It does not keep a timer running.

The command has a 3-minute lateness window by default. For example, if Lingon starts it at `7:02 AM`, it can still run the `7:00 AM` row. To change that:

```bash
cd ~/tesla
npm run due -- --window-minutes 5
```

Useful test commands:

```bash
cd ~/tesla
npm run due -- --dry-run --at 07:00 --force
npm run due -- --dry-run --at 00:00 --force
```

Use one Lingon job for each schedule time:

```text
7:00 AM   /Users/toddhoff/tesla/scripts/run-due.zsh
3:00 PM   /Users/toddhoff/tesla/scripts/run-due.zsh
4:00 PM   /Users/toddhoff/tesla/scripts/run-due.zsh
9:05 PM   /Users/toddhoff/tesla/scripts/run-due.zsh
12:00 AM  /Users/toddhoff/tesla/scripts/run-due.zsh
```

If Lingon lets you specify the executable and arguments separately, use:

```text
Executable: /Users/toddhoff/tesla/scripts/run-due.zsh
Arguments:
Working directory: /Users/toddhoff/tesla
```

### Always-On Local Server

To install the macOS LaunchAgent:

```bash
cd ~/tesla
zsh scripts/install-launchd.zsh
```

To uninstall it:

```bash
cd ~/tesla
zsh scripts/uninstall-launchd.zsh
```

The computer must be awake and online when a scheduled change is due. The LaunchAgent keeps the scheduler process alive after login, but it does not force a sleeping Mac to wake.

## Tesla API Notes

This app uses Tesla Fleet API energy endpoints:

- `GET /api/1/products`
- `POST /api/1/energy_sites/{site_id}/backup`
- `POST /api/1/energy_sites/{site_id}/operation`
- `POST /api/1/energy_sites/{site_id}/grid_import_export`
- `GET /api/1/energy_sites/{site_id}/site_info`
- `GET /api/1/energy_sites/{site_id}/live_status`

Tesla documents the endpoint families, auth model, regions, and required scopes in the official Fleet API docs:

- `https://developer.tesla.com/docs/fleet-api`
- `https://developer.tesla.com/docs/fleet-api/authentication/overview`
- `https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens`
- `https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints`
- `https://developer.tesla.com/docs/fleet-api/endpoints/energy`

The Fleet API may reject settings that your utility, tariff, region, account, or Powerwall firmware does not allow. The UI keeps every response in the activity log so failed payloads can be corrected quickly.

## Safety

- Test with **Dry Run** first.
- Keep Tesla credentials local and do not commit `config/local-settings.json`, `config/tokens.json`, or `.env`.
- Keep your actual outage reserve aligned with your risk tolerance.
- Hot tub lockout still needs to be configured in the hot tub controller or its own automation system. Tesla cannot lock out that load directly unless it is separately controllable.
