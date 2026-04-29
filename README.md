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

## Current Commands

- `!ping`: replies with `pong`
- `!enter`: enters the active giveaway when its keyword is `enter`
- `!gstart codes=6 keyword=enter title="IOI code giveaway"`: starts one active giveaway
- `!gstatus`: reports active giveaway status
- `!gclose`: closes entries before drawing
- `!gdraw` / `!gdraw 6`: draws winners
- `!greroll username`: rerolls an active winner while preserving history
- `!gend`: ends the active giveaway

## Running An IOI Code Giveaway

Start the giveaway:

```text
!gstart codes=6 keyword=enter title="IOI code giveaway"
```

View the current count:

```text
!gstatus
```

Close entries before drawing:

```text
!gclose
```

Draw winners:

```text
!gdraw 6
```

Reroll a winner if needed:

```text
!greroll username
```

End the giveaway:

```text
!gend
```

Never paste IOI codes in chat. VaexCore does not store or reveal codes; delivery stays manual. Before ending, the console logs any active winners that are still unclaimed or undelivered.

## Roadmap

1. Command router, permission levels, custom commands, and cooldowns.
2. Giveaway module with SQLite persistence and audit logs.
3. CLI/admin controls and a small local dashboard only when needed.
