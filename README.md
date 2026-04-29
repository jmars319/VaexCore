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
!gstart codes=6 keyword=enter title="IOI code giveaway"
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

## Local Setup UI

The setup UI is local-only and binds to `127.0.0.1:3434`. It stores Twitch app credentials and OAuth tokens in `config/local.secrets.json`, which is ignored by Git.

1. Create a Twitch Developer app.
2. Set the redirect URI exactly:

```text
http://localhost:3434/auth/twitch/callback
```

3. Run:

```bash
npm run setup
```

4. Open `http://localhost:3434`.
5. Enter your Twitch app client ID, client secret, broadcaster login, and bot login.
6. Click `Save Config`.
7. Click `Connect Twitch` and approve `user:read:chat` and `user:write:chat`.
8. Click `Validate Setup`.
9. Click `Send Test Message`.
10. Run the bot:

```bash
npm run check:env
npm run build
npm run dev
```

Common setup errors:

- `401`: bad, expired, or revoked token. Connect Twitch again.
- `403`: missing scopes. Reconnect and approve both chat scopes.
- Redirect mismatch: the Twitch Developer app redirect URI does not exactly match `http://localhost:3434/auth/twitch/callback`.

The setup UI never displays tokens after OAuth, never logs tokens, and never stores giveaway codes.

## Security Notes

VaexCore treats Twitch chat and local UI input as untrusted. Commands, giveaway fields, logins, display names, and manual chat messages are normalized and length-limited before use. Unknown commands are ignored, denied commands do not expose internals, and command handling includes lightweight per-user and global burst limits.

The setup/operator console binds only to `127.0.0.1`, rejects non-localhost host headers, sends basic browser security headers, and disables caching for API/UI responses. API routes return safe status only; tokens, refresh tokens, client secrets, OAuth codes, and local secrets are never returned.

See [SECURITY.md](SECURITY.md) for local data paths and reset notes.

## Local Operator Console

`npm run setup` also opens the local operator console. This is not a public dashboard; it is a localhost-only control surface for existing VaexCore functionality.

The console can:

- Show safe config and token status.
- Show setup-server queue status.
- Show bot run commands for start/stop/restart. The setup server does not fake process control for the separate `npm run dev` bot.
- Send a chat message when live validation passes.
- Start, close, draw, reroll, claim, deliver, and end giveaways using the same SQLite giveaway service as chat commands.
- Add simulated entrants for local testing through the same `!enter` entry logic.
- Run simulated chat commands through the real command router with viewer, mod, or broadcaster roles.
- Show entrants, winners, and the latest 100 audit log rows.

Codes are still manual. VaexCore does not store, reveal, whisper, or post giveaway codes.

### Operator Console Usage

The UI is the primary local control path. Chat commands remain available for manual operation in Twitch chat, but the console does not depend on Twitch chat to start, close, draw, reroll, claim, deliver, or end a giveaway.

All giveaway buttons call the shared giveaway service directly. The simulated command panel routes through the real command router, so permission checks and command parsing match live chat behavior.

`Echo command to chat` is optional and defaults off. When enabled, the UI runs the action first, then queues the equivalent chat command such as `!gdraw 6`. Echo failures do not undo the local operation, and echoed messages still use VaexCore's outbound rate limit.

Use the testing tools before stream:

1. Start the setup console with `npm run setup`.
2. Use `Run command` as a viewer to confirm protected `!g*` commands are denied.
3. Use `Run command` as broadcaster or the giveaway buttons to start a test giveaway.
4. Add simulated entrants.
5. Close, draw, reroll if needed, mark claimed, mark delivered, and end.
6. Check the audit log for `local-ui` and `simulated-chat` actions.

Recommended stream flow:

1. Run `npm run setup`.
2. Validate the Twitch connection.
3. Send the setup test message.
4. Run `npm run dev` in another terminal.
5. Keep `http://localhost:3434` open as the operator console.
6. Confirm `!ping` in Twitch chat and wait for `LIVE CHAT CONFIRMED`.
7. Start, close, and draw the giveaway from either the UI or chat commands.

## Using VaexCore As A macOS App

The macOS app wraps the same local setup/operator console. It starts the local server internally and opens a VaexCore window, so you do not need to run `npm run setup` manually.

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

## Current Commands

- `!ping`: replies with `pong`
- `!ghelp`: shows concise giveaway operator commands
- `!vcstatus`: shows mode, EventSub, subscription, queue, and giveaway status
- `!enter`: enters the active giveaway when its keyword is `enter`
- `!gstart codes=6 keyword=enter title="IOI code giveaway"`: starts one active giveaway
- `!gstatus`: reports active giveaway status
- `!gclose`: closes entries before drawing
- `!gdraw` / `!gdraw 6`: draws winners
- `!greroll username`: rerolls an active winner while preserving history
- `!gclaim username`: marks a winner as claimed; no code is stored or sent
- `!gdeliver username`: marks a winner as delivered; no code is stored or sent
- `!gend`: ends the active giveaway

## Running An IOI Code Giveaway

Before stream:

```bash
npm run check:env
npm run build
npm run dev
```

Confirm in chat:

```text
!ping
```

Opening:

```text
!gstart codes=6 keyword=enter title="IOI code giveaway"
```

Chat announcement:

```text
Type !enter once to enter. Codes will be sent manually. Do not post codes in chat.
```

During:

```text
!gstatus
```

Closing:

```text
!gclose
```

Drawing:

```text
!gdraw 6
```

If someone does not respond:

```text
!greroll username
```

After manual delivery:

```text
!gclaim username
!gdeliver username
```

End:

```text
!gend
```

Never paste codes into public chat. VaexCore does not store or reveal codes. Before ending, the console logs a winner summary with claimed, delivered, and rerolled status.

## Local Test Transcripts

Normal case:

```text
broadcaster: !gstart codes=6 keyword=enter title="IOI code giveaway"
alice: !enter
bob: !enter
carol: !enter
dave: !enter
erin: !enter
frank: !enter
alice: !enter
broadcaster: !gclose
broadcaster: !gdraw 6
broadcaster: !gclaim alice
broadcaster: !gdeliver alice
broadcaster: !gend
```

Expected chat shape:

```text
Giveaway started: IOI code giveaway. Type !enter to enter. Winners: 6.
Giveaway closed: IOI code giveaway.
Winners: ...
alice marked claimed.
alice marked delivered.
Giveaway ended: IOI code giveaway.
```

Edge case, fewer entrants than codes:

```text
broadcaster: !gstart codes=6 keyword=enter title="IOI code giveaway"
alice: !enter
bob: !enter
carol: !enter
broadcaster: !gclose
broadcaster: !gdraw 6
broadcaster: !greroll alice
broadcaster: !gend
```

Expected chat shape:

```text
Winners (only 3/6 eligible): ...
alice was rerolled. No eligible replacement remains.
Giveaway ended: IOI code giveaway.
```

Permission case:

```text
alice: !gstart codes=6 keyword=enter
mod: !ghelp
broadcaster: !gstart codes=6 keyword=enter title="IOI code giveaway"
```

Expected behavior: normal users are denied in console and do not run `!g*`; mod/broadcaster commands succeed.

## Roadmap

1. Command router, permission levels, custom commands, and cooldowns.
2. Giveaway module with SQLite persistence and audit logs.
3. CLI/admin controls and a small local dashboard only when needed.
