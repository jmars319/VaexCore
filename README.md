# VaexCore

VaexCore is a quiet Twitch operations bot for commands, moderation, giveaways, and stream control without the usual clutter.

## Milestone 1

- Loads `.env`
- Connects to Twitch EventSub WebSocket
- Subscribes to `channel.chat.message`
- Receives chat messages
- Responds to `!ping` through a queued Twitch Send Chat Message API call
- Logs inbound/outbound events

## Requirements

- Node.js 22+
- A Twitch application client ID
- A user access token for the bot account with:
  - `user:read:chat`
  - `user:write:chat`

## Setup

```bash
npm install
cp .env.example .env
npm run check:env
```

Edit `.env` before live startup:

- `VAEXCORE_MODE`: `live` for Twitch, `local` for non-Twitch env checks.
- `TWITCH_CLIENT_ID`: Twitch app client ID.
- `TWITCH_CLIENT_SECRET`: Optional but recommended for CLI auto-refresh.
- `TWITCH_USER_ACCESS_TOKEN`: Bot user access token without the `oauth:` prefix.
- `TWITCH_REFRESH_TOKEN`: Optional but recommended for CLI auto-refresh.
- `TWITCH_BROADCASTER_USER_ID`: Channel owner user ID.
- `TWITCH_BOT_USER_ID`: Bot account user ID.
- `COMMAND_PREFIX`: Optional command prefix. Defaults to `!`.
- `LOG_LEVEL`: Optional logger level. Defaults to `info`.

The Twitch user access token must belong to the bot user and include these scopes:

- `user:read:chat`
- `user:write:chat`

`npm run check:env` validates that required values are present and catches local formatting mistakes, such as using an `oauth:` prefix. If `TWITCH_CLIENT_SECRET` and `TWITCH_REFRESH_TOKEN` are present, VaexCore imports them into the local OAuth store so future CLI starts can refresh expired access tokens. It cannot verify token scopes offline; Twitch confirms those when VaexCore creates the chat subscription and sends a message.

## Git Hygiene

VaexCore does not initialize Git automatically. If this folder is not a Git repo yet, use:

```bash
git init
git add .
git commit -m "Scaffold VaexCore core and giveaway module"
```

## Local Command Test

Use local mode before connecting to Twitch:

```bash
npm run dev:local
```

Then type:

```text
!ping
```

Expected output after the queue interval:

```text
[queued outbound] pong
```

For giveaway testing, unprefixed lines run as the local broadcaster. Viewer identities can be simulated with `name: message`:

```text
!gstart codes=3 keyword=enter title="Community Giveaway"
alice: !enter
bob: !enter
carol: !enter
dave: !enter
erin: !enter
frank: !enter
!gstatus
!gclose
!gdraw 6
!greroll alice
!gend
```

Exit local mode with `/quit`, `/exit`, or `Ctrl+C`.

## Live Startup

After `.env` passes:

```bash
npm run dev
```

If you configured Twitch in the packaged macOS app instead of `.env`, start the live bot with the app config:

```bash
npm run dev:app-config
```

Access-token-only `.env` files still work. For easier long-term CLI use, include `TWITCH_CLIENT_SECRET` and `TWITCH_REFRESH_TOKEN` once, then let VaexCore keep rotated OAuth tokens in `config/local.secrets.json`.

Startup logs should include these checklist entries:

- `bot user ID present`
- `broadcaster ID present`
- `outbound message queue ready`
- `EventSub connected`
- `chat subscription created`

Once running, type `!ping` in your Twitch chat. VaexCore should receive the chat event and send one queued `pong` through Twitch's Send Chat Message API.

Live mode receives real Twitch user IDs, logins, display names, and badges from EventSub. Local mode is the only mode that accepts fake users such as `alice: !enter`.

The operator console can also start and stop the live bot listener from `Dashboard` -> `Bot Runtime`. This uses the same local credentials as the console and keeps recent bot logs visible in the UI. Keep the console open while the managed bot process is running.

If Twitch rejects startup with `401` or `403`, check:

- The token belongs to `TWITCH_BOT_USER_ID`.
- The token was created for `TWITCH_CLIENT_ID`.
- The token has `user:read:chat` for EventSub chat messages.
- The token has `user:write:chat` for sending chat messages.
- `TWITCH_BROADCASTER_USER_ID` is the channel owner ID.

## Going Live With VaexCore

1. Use `Settings` -> `Setup Guide`, or fill `.env` with `VAEXCORE_MODE=live`, Twitch client ID, bot token, bot user ID, broadcaster user ID, and preferably the client secret plus refresh token for CLI auto-refresh.
2. Run `npm run check:env`.
3. Run `npm run build`.
4. Start VaexCore from `Dashboard` -> `Bot Runtime` -> `Start Bot`. CLI fallback remains `npm run dev`, or `npm run dev:app-config` if setup was completed in the packaged macOS app.
5. Watch logs for `EventSub connected` and `Chat subscription created`.
6. Type `!ping` in your channel.
7. Confirm the bot responds with `pong` and logs `LIVE CHAT CONFIRMED`.
8. Only then run the giveaway.

Expected startup banner:

```text
VaexCore LIVE MODE -- waiting for chat confirmation (!ping)
```

Common live errors:

- `401`: bad, expired, revoked, or wrong-account token. Generate a fresh user access token.
- `403`: missing scopes. Re-auth the bot token with `user:read:chat` and `user:write:chat`.
- No chat messages received: check EventSub subscription logs, broadcaster ID, bot user ID, and token ownership.

Enable `VAEXCORE_DEBUG=true` only when debugging. It logs truncated raw EventSub payloads and normalized chat messages.

## Using The Local Operator Console

VaexCore includes a localhost-only operator console for setup, live readiness checks, giveaway operation, chat tools, testing, and audit review. It binds to `127.0.0.1:3434` and is not intended for public hosting.

Run the console from the project:

```bash
npm run setup
```

Then open:

```text
http://localhost:3434
```

The console is organized into durable sections:

- `Dashboard`: high-level Twitch, queue, chat, active giveaway readiness, live runbook, and preflight rehearsal.
- `Live Mode`: compact stream-night state, live runbook, status-to-chat, panic resend, outbound failure logs, and recap copy.
- `Commands`: create, edit, test, import, export, and audit local custom chat commands.
- `Timers`: create, enable, disable, and monitor scheduled chat messages behind live readiness and queue guardrails.
- `Moderation`: configure lightweight warn-only filters, blocked phrases, local simulations, and recent moderation hits.
- `Giveaways`: start, close, draw, reroll, claim, deliver, end giveaways, manage reminder timing, edit giveaway chat templates, and review the latest recap.
- `Chat Tools`: send chat messages, send test messages, edit local operator message presets, and control optional chat echo.
- `Testing`: simulate entrants and commands before using a live stream.
- `Settings`: configure mode, Twitch OAuth, bot identity, and broadcaster identity.
- `Diagnostics`: copy a safe local report or support bundle with app version, runtime, config path, database path, SQLite driver, setup assets, first-run recovery steps, readiness checks, and current runtime state.
- `Audit Log`: review post-stream summaries and the latest 100 local audit entries.

Direct UI actions call the local service layer first. Optional chat echo is visibility only; if enabled, VaexCore queues the equivalent chat command after the local action succeeds.

Major optional modules use local feature gates with `off`, `test`, and `live` modes. `test` allows local simulation without responding to Twitch chat, which makes new workflows safer to validate during a stream.

## Custom Chat Commands

Open `Commands` to manage local command definitions stored in SQLite. Custom commands support:

- enable/disable state
- viewer, moderator, or broadcaster permission levels
- separate global and per-user cooldowns
- aliases such as `!discord`, `!links`, and `!socials`
- random response variants, one per line
- safe placeholders: `{user}`, `{displayName}`, `{login}`, `{args}`, `{arg1}` through `{arg9}`, `{target}`, and `{count}`
- preview and local command testing before going live
- JSON import/export for backup or moving setup between machines
- use counts, last-used timestamps, recent invocation history, and audit entries

Built-in names such as `!ping`, `!vcstatus`, and giveaway commands are reserved through the protected command registry. While a giveaway is active, its entry keyword is also reserved in the setup UI. At runtime, built-in commands and active giveaway keywords are checked before custom command fallback, so giveaway entry behavior stays predictable.

The `Commands` tab includes a feature gate for custom commands. `Live` responds in Twitch chat, `Test` responds only to local simulations, and `Off` disables custom command replies while keeping definitions available.

## Timers

Open `Timers` to manage scheduled chat messages stored locally in SQLite. Timers support:

- feature-gated rollout with `off`, `test`, and `live` modes
- enable/disable without deleting the timer definition
- minimum 5-minute intervals
- bounded, redacted timer messages
- next fire time, last sent time, last status, and send count
- manual `Send now` only when timers are live, the bot is live-ready, and the outbound queue is clear
- audit entries for create, update, delete, enable, and disable actions

Automatic timer delivery runs in the live bot runtime and uses the same outbound message queue, retry handling, rate-limit behavior, and outbound history as other VaexCore chat sends. Timers do not fire while the Timers feature gate is `off` or `test`, before live chat confirmation, or while the outbound queue is degraded.

## Basic Moderation Filters

Open `Moderation` to configure lightweight local filters. Moderation filters support:

- feature-gated rollout with `off`, `test`, and `live` modes
- blocked phrases/words
- link detection
- excessive caps detection
- repeated message detection
- excessive symbol spam detection
- warn-only action using the outbound queue
- local simulation before going live
- recent moderation hit history and audit entries

All moderation filters default off, and the `moderation_filters` feature gate defaults off. VaexCore does not ban automatically and does not use ML moderation or public blocklists. Protected bot commands and the active giveaway entry keyword are exempt so `!enter`, giveaway controls, and core commands stay predictable.

Delete/timeout enforcement is intentionally not enabled yet because VaexCore does not currently have a properly scoped Twitch moderation API client. Current moderation responses are warnings only, and every warning uses the approved outbound queue.

## First-Time Setup (No Twitch Experience Required)

Open `Settings`, then use `Setup Guide`.

1. Create a Twitch application.
   Open `https://dev.twitch.tv/console/apps`, click `Register Your Application`, use any name such as `VaexCore`, set OAuth Redirect URL to `http://localhost:3434/auth/twitch/callback`, and choose `Application Integration`. Use one redirect URL only; do not leave a second blank redirect row. The redirect URL must match exactly.
2. Enter app credentials.
   Copy the Twitch app `Client ID` and `Client Secret` into VaexCore. Keep the Redirect URI as `http://localhost:3434/auth/twitch/callback` unless you know why it must change.
3. Enter Twitch usernames.
   `Broadcaster Login` is the channel VaexCore operates in. `Bot Login` is the account that sends messages. They can be the same account or separate accounts. If they are separate, the Bot Login must be the account that grants OAuth in the next step.
4. Connect Twitch.
   Click `Connect Twitch` while logged into the Bot Login account and approve `user:read:chat` and `user:write:chat`. The Client ID and Client Secret belong to the Twitch Developer App, not to one authorized Twitch user.
   If Twitch authorizes the wrong account, click `Disconnect Twitch`, switch Twitch accounts in the browser, then connect again.
5. Validate setup.
   Click `Validate Setup` and confirm token, scopes, bot identity, and broadcaster identity pass. VaexCore stores Twitch OAuth tokens locally and refreshes expired access tokens automatically when Twitch returns `401 Unauthorized`; if refresh fails, disconnect and reconnect Twitch.
6. Test chat.
   Click `Send test message` to confirm the bot can speak in chat.
7. Start the bot.
   Click `Start Bot` in the Setup Guide or Dashboard. CLI fallback is `npm run dev:app-config` after using the packaged macOS app setup, or `npm run dev` after using project-local setup or `.env`. Type `!ping` in Twitch chat and wait for `LIVE CHAT CONFIRMED`.

### Operator UI Structure

The setup server API lives in `src/setup/server.ts`. The browser UI is static, componentized plain JavaScript and CSS in:

```text
src/setup/ui/app.js
src/setup/ui/styles.css
```

This keeps the console lightweight and avoids a separate frontend framework build. `npm run setup` serves those source files directly. `npm run build` bundles the setup server and copies the same UI files into `dist-bundle/setup-ui` for the Electron app.

After UI changes, run:

```bash
npm run typecheck
npm run build
npm run smoke:cli-env
npm run smoke:token-refresh
npm run smoke:commands
npm run smoke:diagnostics
npm run smoke:clean-install
npm run setup
```

Then open `http://localhost:3434` and smoke test tab navigation, giveaway state loading, simulated commands, and the lifecycle test.

## Configuring Twitch

Create a Twitch Developer app and set the redirect URI exactly:

```text
http://localhost:3434/auth/twitch/callback
```

In the `Settings` section:

1. Select `live` mode.
2. Enter Twitch client ID and client secret.
3. Enter broadcaster login and bot login.
4. Save settings.
5. Connect Twitch while logged into the bot login account and approve `user:read:chat` and `user:write:chat`.
6. Validate setup.
7. Send a setup test message from `Chat Tools`.

Common setup errors:

- `401`: bad, expired, or revoked token. VaexCore will try to refresh it automatically when a refresh token is available; if refresh fails, connect Twitch again.
- `403`: missing scopes. Reconnect and approve both chat scopes.
- Bot identity mismatch: click `Disconnect Twitch`, log into Twitch as the configured bot login, then connect again.
- Redirect mismatch: the Twitch Developer app redirect URI does not exactly match `http://localhost:3434/auth/twitch/callback`.

The setup UI never displays tokens after OAuth, never logs tokens, and never stores giveaway prizes.

## Security Notes

VaexCore treats Twitch chat and local UI input as untrusted. Commands, custom command definitions, giveaway fields, logins, display names, and manual chat messages are normalized and length-limited before use. Unknown commands are ignored, denied commands do not expose internals, and command handling includes lightweight per-user and global burst limits.

The setup/operator console binds only to `127.0.0.1`, rejects non-localhost host headers, sends basic browser security headers, and disables caching for API/UI responses. API routes return safe status only; tokens, refresh tokens, client secrets, OAuth authorization values, and local secrets are never returned.

Audit entries are redacted and bounded. VaexCore keeps the latest 1,000 audit rows for up to 90 days by default, and diagnostics/support exports read audit metadata through the same redaction path.

See [SECURITY.md](SECURITY.md) for local data paths and reset notes.

## Running Giveaways

VaexCore supports one active giveaway at a time. Entries are unique by Twitch user ID in live mode and by simulated user identity in local testing.

Recommended operator flow:

1. Confirm the Dashboard shows Twitch auth, queue readiness, and live chat confirmation.
2. Open `Giveaways`.
3. Start a giveaway with a title, keyword, and number of winners.
4. VaexCore announces the entry keyword in chat.
5. Monitor entry count.
6. Close entries.
7. Draw winners.
8. Reroll, claim, or deliver winners as needed.
9. End the giveaway after operator work is complete.

Giveaway chat announcements are automatic when chat is configured. VaexCore announces start instructions, thanks each unique entrant, acknowledges duplicate entries, announces closed entries, announces drawn/rerolled winners, and repeats the final winner list when the giveaway ends. Custom keywords work too: `keyword=raffle` means viewers enter with `!raffle`.

The `Giveaways` tab also includes stream-night controls:

- `Preflight Rehearsal` on the Dashboard checks Twitch setup, bot runtime, EventSub, live chat confirmation, outbound failures, and giveaway state before going live.
- `Reminder Controls` can queue timed reminder messages while entries are open. The enabled state and interval are stored locally in SQLite, and reminders stop queuing when entries are not open.
- `Message Templates` stores non-secret local giveaway wording in SQLite. Supported placeholders include `{title}`, `{keyword}`, `{winnerCount}`, `{entryCount}`, `{displayName}`, `{winners}`, `{rerolled}`, and `{replacement}`.
- `Post-Giveaway Recap` summarizes the latest giveaway, winners, pending delivery, and critical chat message failures.
- `Copy winners` and `Mark all delivered` help close out manual delivery without storing prize codes.
- `Giveaway Chat Assurance` tracks start, reminder/last-call, close, draw, and end announcement phases. If a critical phase is missing or failed, VaexCore shows a do-not-continue warning and offers phase-level send/resend controls.
- `Live Mode` keeps the current operator state explicit: `entries open`, `ready to draw`, `delivery pending`, `safe to end`, or `giveaway ended`. It can send the current giveaway status to chat, panic-resend the latest failed critical giveaway message, show outbound failure logs separately, and copy a post-stream recap for notes.
- `Queue Health` and `Recovery Checklist` show pending queue age, retry delay, send throttle delay, failure category, latest failed action, resend safety, and concrete recovery steps before an operator retries a critical message. Auth/config failures do not blindly retry; Twitch rate limits and transient network failures retry with queue-owned backoff.
- `Operator Messages` in Chat Tools stores local-only canned chat messages in SQLite for stream-safe communication. High-impact presets require confirmation and every send uses the same outbound queue, history, retry, and recovery path as giveaway chat.
- `Commands` stores local-only custom chat commands in SQLite, with aliases, cooldowns, permission checks, response variants, usage history, import/export, and audit logging.
- `Timers` stores local-only scheduled chat messages in SQLite. Timers are feature-gated, use the outbound queue, and wait for live readiness plus clear queue health before sending.
- `Moderation` stores local-only warn-only filter settings, blocked phrases, and recent hits in SQLite. Moderation is feature-gated, fails open, and exempts protected commands plus active giveaway entry commands.
- `Feature Gates` keep major modules isolated with `off`, `test`, and `live` states. Custom commands default to `live`; timers and moderation filters start `off` until explicitly enabled.
- `Development Guidelines` live in `docs/development-guidelines.md` and define the project rules for preserving the stable core, local-first behavior, secret redaction, feature gates, audit retention, diagnostics, and release discipline.
- `Live Runbook` turns current setup, bot, queue, recovery, and giveaway state into a prioritized next-action checklist. It reuses existing controls and can copy a compact incident note for post-stream review.
- `Post-Stream Review` in Audit Log summarizes the latest giveaway, winners, delivery state, outbound failures, retries, bot errors, and recent audit entries. It can copy a text review or export local JSON.
- Critical giveaway guardrails treat queued, sending, retrying, missing, and failed required chat announcements as blocking until the outbound queue confirms `sent` or `resent`. Phase rows show queue status, queue ID, retry timing, failure category, and the next recovery action.
- `npm run smoke:giveaway` runs a temp-database giveaway readiness check covering command permissions, entry, close, draw, reroll, delivery, audit logs, recap, outbound history, and the local lifecycle test.
- `npm run smoke:giveaway-live` runs the stream-night giveaway rehearsal covering UI/API start, chat commands, five entrants, duplicate entry handling, insufficient entrants, reroll, manual claim/delivery, restart persistence, outbound assurance, and custom command/timer/moderation interference checks.
- `npm run smoke:commands` runs a temp-database custom command check covering reserved names, aliases, placeholders, permissions, cooldowns, disabled commands, preview, import/export, usage history, and audit logs.
- `npm run smoke:guardrails` checks protected command validation, feature gate behavior, custom command secret rejection, diagnostics/support feature-gate reporting, audit redaction, and audit retention.
- `npm run smoke:timers` checks timer feature-gate behavior, minimum intervals, secret rejection, audit logging, live-readiness blocking, and scheduler no-spam behavior.
- `npm run smoke:moderation` checks moderation feature-gate behavior, disabled-by-default filters, blocked phrases, links, caps, repeat and symbol detection, protected command exemptions, recent hits, and audit logging.
- `npm run smoke:cli-env` proves a refresh-capable `.env` can bootstrap the local OAuth store while access-token-only `.env` files remain supported.
- `npm run smoke:token-refresh` runs a mocked Twitch OAuth check proving an expired access token refreshes, stores the rotated refresh token, keeps secrets out of `/api/config`, and sends chat with the refreshed token.
- `npm run smoke:diagnostics` checks the local diagnostics route, setup assets, database driver, token-refresh readiness flags, and report redaction.
- `npm run smoke:clean-install` checks a fresh app data folder, first-run recovery guidance, blocked bot startup before setup, and support bundle redaction.

Current chat command syntax:

```text
!gstart codes=3 keyword=enter title="Community Giveaway"
!enter
!gstatus
!gclose
!gdraw 3
!greroll username
!gclaim username
!gdeliver username
!gend
```

The `codes` option in `!gstart` is the current command name for the number of winners. The UI labels this as `Number of winners`.

## Manual Prize Delivery

VaexCore does not store or reveal giveaway prizes. Delivery remains manual.

Use these actions only to track operator state:

```text
!gclaim username
!gdeliver username
```

Before ending a giveaway, VaexCore logs a summary of winners, claimed status, delivered status, and rerolled status.

## Testing Before Stream

Use local testing to verify command parsing, permissions, and giveaway lifecycle behavior without Twitch.

CLI local mode:

```bash
npm run dev:local
```

Example transcript:

```text
broadcaster: !gstart codes=3 keyword=enter title="Community Giveaway"
alice: !enter
bob: !enter
carol: !enter
alice: !enter
broadcaster: !gclose
broadcaster: !gdraw 3
broadcaster: !gclaim alice
broadcaster: !gdeliver alice
broadcaster: !gend
```

Expected behavior:

```text
Giveaway started: Community Giveaway. Type !enter to enter. Winners: 3.
Giveaway closed: Community Giveaway.
Winners: ...
alice marked claimed.
alice marked delivered.
Giveaway ended: Community Giveaway.
```

Permission check example:

```text
alice: !gstart codes=3 keyword=enter
mod: !ghelp
broadcaster: !gstart codes=3 keyword=enter title="Community Giveaway"
```

Normal users are denied for protected giveaway commands. Mod and broadcaster commands run according to centralized permissions.

## Using VaexCore As A macOS App

The macOS app wraps the same local operator console. It starts the local server internally and opens a VaexCore window, so you do not need to run `npm run setup` manually.

Build the app:

```bash
npm run app:build
```

Create a DMG:

```bash
npm run app:dist
```

Create an unsigned tester zip:

```bash
npm run app:zip
npm run smoke:unsigned-release
npm run smoke:tester-artifact
npm run smoke:tester-update
```

Run the full unsigned release checklist:

```bash
npm run release:unsigned
```

`npm run release:unsigned` starts with `npm run release:guard`, which requires `main`, a clean working tree, and no unpushed or unpulled commits. Commit and push release changes before running it.

Outputs are written to:

```text
release/
```

The `.app` bundle can be copied into `/Applications`. The DMG, when built, can be opened and installed normally. The unsigned tester zip writes a `.zip`, `.zip.sha256`, `.json` manifest, and `-handoff.md` tester note under `release/`.

`npm run smoke:tester-artifact` extracts that zip into a temporary folder, launches the extracted `VaexCore.app` with isolated app data, and verifies the setup UI, Diagnostics, support bundle redaction, and packaged `better-sqlite3` path.
`npm run smoke:tester-update` launches the same extracted artifact against a seeded existing app-data folder and verifies Twitch setup flags, safe config redaction, and SQLite audit data survive the app replacement.

App-local data is stored under:

```text
~/Library/Application Support/VaexCore
```

That folder contains `local.secrets.json` and `data/vaexcore.sqlite`. To reset the app config, quit VaexCore and remove that folder. Development CLI mode still uses the project-local config path unless `VAEXCORE_CONFIG_DIR` is set.

For normal tester updates, replace only `VaexCore.app`; do not delete this Application Support folder unless you intentionally want to reset Twitch setup and local giveaway/operator data.

CLI fallback remains available:

```bash
npm run setup
npm run dev
```

If the packaged app was used for Twitch setup, the live CLI needs the packaged app's config path:

```bash
npm run dev:app-config
```

After changing setup UI assets, run `npm run app:build` again so `dist-bundle/setup-ui` is refreshed before packaging. Electron loads the same localhost setup server as `npm run setup`.

VaexCore uses native `better-sqlite3`. The app build leaves the project `node_modules` on the normal Node ABI, then installs the Electron ABI prebuild into the packaged `.app`, re-signs the app bundle so macOS accepts the modified native module, and probes it before finishing. A `node:sqlite` fallback remains as a last resort if a future Electron/native prebuild is unavailable; that fallback may emit Node's experimental SQLite warning.

For support handoff, open `Diagnostics` and click `Copy diagnostic report` for the short report or `Copy support bundle` for diagnostics plus recent non-secret bot logs, outbound history, and audit summaries. Both are local-only and intentionally omit Twitch client secrets, access tokens, and refresh tokens while still showing the paths and readiness checks needed to troubleshoot setup or packaging.

### Unsigned Tester Builds

VaexCore currently has no Apple Developer ID signing or notarization. That means tester builds are intentionally labeled unsigned and macOS may show an unidentified developer warning. Share only zips you built yourself from this repo, and include the `.zip.sha256` checksum and `.json` manifest with the zip.

For non-developer testers, send [TESTER_GUIDE.md](TESTER_GUIDE.md) with the unsigned zip.

Tester install flow:

1. Download the unsigned zip and matching `.zip.sha256` file.
2. Optional checksum check:

   ```bash
   cd ~/Downloads
   shasum -a 256 -c VaexCore-0.1.1-mac-arm64-unsigned.zip.sha256
   ```

3. Unzip the archive and move `VaexCore.app` to `/Applications`.
4. First launch may require right-clicking `VaexCore.app` and choosing `Open`, or opening `System Settings -> Privacy & Security` and choosing `Open Anyway`.
5. Open `Diagnostics` and verify SQLite says `better-sqlite3`, Setup UI assets are present, and first-run recovery points to `Settings -> Setup Guide` if the app is not configured yet.

Tester update flow:

1. Quit VaexCore.
2. Unzip the new archive.
3. Replace the old `VaexCore.app` in `/Applications`.
4. Do not delete `~/Library/Application Support/VaexCore`.
5. Open VaexCore and check `Diagnostics -> About This Build` for the new version.

Do not describe these builds as notarized. Public distribution should wait until Developer ID signing and notarization are available.

### Release Checklist

Before sharing a tester build:

1. Update `package.json` version when the artifact should have a new filename.
2. Add or update the matching section in `CHANGELOG.md`.
3. Commit and push the release cut to `main`.
4. Run `npm run release:unsigned`.
5. Confirm the tester artifact dry run and tester update preservation checks passed.
6. Share the generated `.zip`, `.zip.sha256`, `.json`, and `-handoff.md` from `release/`.
7. Tell testers the build is unsigned, ad-hoc signed, and not notarized.

### Known Limitations

- Current tester artifact is macOS arm64 only.
- Builds are ad-hoc signed, not Developer ID signed, and not notarized.
- First launch may require the macOS unidentified-developer override.
- VaexCore is local-first only; it is not a SaaS/public hosted bot.
- Prize codes are never stored. Manual delivery remains outside VaexCore.

### Installing, Resetting, And Recovering

On first launch, VaexCore should open directly to the local setup console. If setup is incomplete, use `Settings -> Setup Guide`; Diagnostics will show the exact missing fields and recovery steps. `Start Bot` validates and refreshes Twitch OAuth first, then blocks with concrete checks instead of launching a broken runtime.

If the app cannot open because port `3434` is busy, quit the other VaexCore instance or any process using `localhost:3434`, then reopen VaexCore. If the app opens but SQLite reports fallback or database failure in Diagnostics, run `npm run app:build` again. Reset local app data only after backing up anything you need from `~/Library/Application Support/VaexCore`.

If Electron fails to load the packaged app after Node, Electron, or dependency upgrades, reinstall dependencies and rebuild the package:

```bash
npm install
npm run app:build
```

## Current Commands

- `!ping`: replies with `pong`
- `!ghelp`: shows concise giveaway operator commands
- `!vcstatus`: shows mode, EventSub, subscription, queue, and giveaway status
- `!enter`: enters the active giveaway when its keyword is `enter`
- `!gstart codes=3 keyword=enter title="Community Giveaway"`: starts one active giveaway
- `!gstatus`: reports active giveaway status
- `!gclose`: closes entries before drawing
- `!gdraw` / `!gdraw 3`: draws winners
- `!greroll username`: rerolls an active winner while preserving history
- `!gclaim username`: marks a winner as claimed; no prize is stored or sent
- `!gdeliver username`: marks a winner as delivered; no prize is stored or sent
- `!gend`: ends the active giveaway

## Roadmap

1. Command router, permission levels, custom commands, and cooldowns.
2. Giveaway module with SQLite persistence and audit logs.
3. CLI/admin controls and a small local dashboard only when needed.
