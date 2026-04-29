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
- `TWITCH_USER_ACCESS_TOKEN`: Bot user access token without the `oauth:` prefix.
- `TWITCH_BROADCASTER_USER_ID`: Channel owner user ID.
- `TWITCH_BOT_USER_ID`: Bot account user ID.
- `COMMAND_PREFIX`: Optional command prefix. Defaults to `!`.
- `LOG_LEVEL`: Optional logger level. Defaults to `info`.

The Twitch user access token must belong to the bot user and include these scopes:

- `user:read:chat`
- `user:write:chat`

`npm run check:env` validates that required values are present and catches local formatting mistakes, such as using an `oauth:` prefix. It cannot verify token scopes offline; Twitch confirms those when VaexCore creates the chat subscription and sends a message.

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

Startup logs should include these checklist entries:

- `bot user ID present`
- `broadcaster ID present`
- `outbound message queue ready`
- `EventSub connected`
- `chat subscription created`

Once running, type `!ping` in your Twitch chat. VaexCore should receive the chat event and send one queued `pong` through Twitch's Send Chat Message API.

Live mode receives real Twitch user IDs, logins, display names, and badges from EventSub. Local mode is the only mode that accepts fake users such as `alice: !enter`.

If Twitch rejects startup with `401` or `403`, check:

- The token belongs to `TWITCH_BOT_USER_ID`.
- The token was created for `TWITCH_CLIENT_ID`.
- The token has `user:read:chat` for EventSub chat messages.
- The token has `user:write:chat` for sending chat messages.
- `TWITCH_BROADCASTER_USER_ID` is the channel owner ID.

## Going Live With VaexCore

1. Fill `.env` with `VAEXCORE_MODE=live`, Twitch client ID, bot token, bot user ID, and broadcaster user ID.
2. Run `npm run check:env`.
3. Run `npm run build`.
4. Start VaexCore with `npm run dev`.
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

- `Dashboard`: high-level Twitch, queue, chat, and active giveaway readiness.
- `Giveaways`: start, close, draw, reroll, claim, deliver, and end giveaways.
- `Chat Tools`: send chat messages, send test messages, and control optional chat echo.
- `Testing`: simulate entrants and commands before using a live stream.
- `Settings`: configure mode, Twitch OAuth, bot identity, and broadcaster identity.
- `Audit Log`: review the latest 100 local audit entries.

Direct UI actions call the local service layer first. Optional chat echo is visibility only; if enabled, VaexCore queues the equivalent chat command after the local action succeeds.

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
5. Connect Twitch and approve `user:read:chat` and `user:write:chat`.
6. Validate setup.
7. Send a setup test message from `Chat Tools`.

Common setup errors:

- `401`: bad, expired, or revoked token. Connect Twitch again.
- `403`: missing scopes. Reconnect and approve both chat scopes.
- Redirect mismatch: the Twitch Developer app redirect URI does not exactly match `http://localhost:3434/auth/twitch/callback`.

The setup UI never displays tokens after OAuth, never logs tokens, and never stores giveaway prizes.

## Security Notes

VaexCore treats Twitch chat and local UI input as untrusted. Commands, giveaway fields, logins, display names, and manual chat messages are normalized and length-limited before use. Unknown commands are ignored, denied commands do not expose internals, and command handling includes lightweight per-user and global burst limits.

The setup/operator console binds only to `127.0.0.1`, rejects non-localhost host headers, sends basic browser security headers, and disables caching for API/UI responses. API routes return safe status only; tokens, refresh tokens, client secrets, OAuth authorization values, and local secrets are never returned.

See [SECURITY.md](SECURITY.md) for local data paths and reset notes.

## Running Giveaways

VaexCore supports one active giveaway at a time. Entries are unique by Twitch user ID in live mode and by simulated user identity in local testing.

Recommended operator flow:

1. Confirm the Dashboard shows Twitch auth, queue readiness, and live chat confirmation.
2. Open `Giveaways`.
3. Start a giveaway with a title, keyword, and number of winners.
4. Announce the entry keyword in chat.
5. Monitor entry count.
6. Close entries.
7. Draw winners.
8. Reroll, claim, or deliver winners as needed.
9. End the giveaway after operator work is complete.

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

Outputs are written to:

```text
release/
```

The `.app` bundle can be copied into `/Applications`. The DMG, when built, can be opened and installed normally.

App-local data is stored under:

```text
~/Library/Application Support/VaexCore
```

That folder contains `local.secrets.json` and `data/vaexcore.sqlite`. To reset the app config, quit VaexCore and remove that folder. Development CLI mode still uses the project-local config path unless `VAEXCORE_CONFIG_DIR` is set.

CLI fallback remains available:

```bash
npm run setup
npm run dev
```

After changing setup UI assets, run `npm run app:build` again so `dist-bundle/setup-ui` is refreshed before packaging. Electron loads the same localhost setup server as `npm run setup`.

VaexCore uses native `better-sqlite3`. If Electron fails to load the packaged app after Node, Electron, or dependency upgrades, reinstall dependencies and rebuild the package so native modules are rebuilt for Electron:

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
