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
