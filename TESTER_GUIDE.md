# vaexcore console Tester Guide

This guide is for early testers running the unsigned macOS build.

vaexcore console is local-first. It runs on your Mac, stores Twitch setup locally, and opens a local operator console. It is not a public website or SaaS service.

## Before You Start

You need:

- A Mac with Apple silicon.
- The vaexcore console unsigned zip.
- The matching `.zip.sha256` checksum file.
- A Twitch account for the bot. This can be the same as the broadcaster account, or a separate bot account.

This build is unsigned and not notarized. macOS may warn that the developer cannot be verified. Only run a build that came directly from the maintainer.

Before sharing the zip, the maintainer should have run the tester artifact dry run, tester update preservation check, operational guardrails smoke, timers smoke, moderation smoke, and bot replacement smoke. Those dry runs launch the extracted app from the zip, check the local setup UI, confirm Diagnostics and support bundle redaction, verify packaged SQLite reports `better-sqlite3`, prove an existing local setup survives app replacement, and confirm protected commands, feature gates, timers, moderation filters, stream presets, and audit redaction behave safely.

## Install

1. Put the `.zip` and `.zip.sha256` files in `Downloads`.
2. Optional checksum check:

   ```bash
   cd ~/Downloads
   shasum -a 256 -c vaexcore-console-0.1.1-mac-arm64-unsigned.zip.sha256
   ```

3. Unzip the archive.
4. Move `vaexcore console.app` to `/Applications`.
5. Open the app.

If macOS blocks the first launch:

1. Right-click `vaexcore console.app`.
2. Choose `Open`.
3. Confirm `Open` again if macOS asks.
4. If there is no `Open` button, open `System Settings -> Privacy & Security`, scroll down, and choose `Open Anyway`.

## Updating vaexcore console

When you receive a newer unsigned zip:

1. Quit vaexcore console.
2. Unzip the new archive.
3. Replace the old `vaexcore console.app` in `/Applications`.
4. Do not delete:

   ```text
   ~/Library/Application Support/vaexcore console
   ```

5. Open vaexcore console.
6. Open `Diagnostics -> About This Build` and confirm the version changed.

That Application Support folder is where Twitch setup, tokens, giveaway data, and local operator data live. Deleting it resets vaexcore console.

If you updated from an older pre-rename build, Diagnostics may show a legacy Application Support folder instead. Keep the folder Diagnostics shows during app replacement.

## First Setup

Open `Settings -> Setup Guide` in vaexcore console and follow the steps there.

The short version:

1. Create a Twitch Developer application.
2. Use this OAuth Redirect URL exactly:

   ```text
   http://localhost:3434/auth/twitch/callback
   ```

3. Save the Twitch Client ID and Client Secret in vaexcore console.
4. Enter Broadcaster Login and Bot Login.
5. Click `Connect Twitch` while logged into the bot account.
6. Click `Validate Setup`.
7. Click `Send test message`.
8. Click `Start Bot`.
9. Type `!ping` in Twitch chat and confirm vaexcore console sees live chat.

## Giveaway Test

Before using a real giveaway, run a tiny test:

1. Open `Giveaways`.
2. Start a giveaway with keyword `enter`.
3. Type `!enter` in Twitch chat.
4. Close entries.
5. Draw winner.
6. Confirm the app shows the entrant and winner.
7. End the giveaway.

Do not put prize codes into vaexcore console. Deliver prizes manually outside the app.

## Custom Commands Test

Open `Commands`, create a simple command such as `!discord`, add one response, click `Preview response`, then `Run test command`. You can also create a utility pack disabled, edit placeholder links/copy, then enable only the commands you have tested. For live use, start the bot and type the command in Twitch chat after `!ping` confirms live chat.

## Bot Replacement Test

Open `Dashboard` or `Live Mode`, apply `Local Bot Rehearsal`, then use starter commands, timer presets, and moderation local tests before enabling live timers or live moderation. Timers can require non-command chat activity before each automatic send; check the `Activity` column before stream if you expect a timer to stay quiet in slow chat. `Bot Replacement` requires confirmation because it moves timers and scoped moderation into live chat. Delete and timeout actions stay unavailable until the optional Twitch moderation scopes are granted.

For moderation, use the local test before enabling live mode. Plain blocked phrases are boundary-aware; use `*` only when you intentionally want broader matching. Put known-bad domains in `Blocked Link Domains` and trusted domains in `Allowed Link Domains`.

## Send A Support Bundle

If something goes wrong:

1. Open `Diagnostics`.
2. Click `Copy support bundle`.
3. Paste it into a message to the maintainer.

The support bundle is designed to omit Twitch client secrets, access tokens, and refresh tokens.

## Known Errors And Fixes

### Port 3434 Is Busy

vaexcore console uses `localhost:3434`. If the app says the port is already in use, quit other vaexcore console windows first. If it still happens, restart the Mac or ask the maintainer for help with this command:

```bash
lsof -nP -iTCP:3434 -sTCP:LISTEN
```

### Invalid Token

If validation says the Twitch token is invalid, click `Connect Twitch` again. If you changed bot accounts, use `Disconnect Twitch`, log into the correct Twitch account in your browser, then connect again.

### Wrong Bot Account

If validation says the OAuth token belongs to a different account, the browser authorized the wrong Twitch user. Use `Disconnect Twitch`, switch Twitch accounts in the browser, then `Connect Twitch` again.

### SQLite Fallback Or Database Warning

Open `Diagnostics`. If SQLite does not say `better-sqlite3`, send a support bundle. Do not delete app data unless the maintainer tells you to.

### Giveaway Chat Did Not Send

Open `Live Mode` or `Giveaways` and look for `Giveaway Chat Assurance`. If there is a failed critical message, use the resend controls after checking that chat really missed the message.

## Reset Local Setup

Only do this if the maintainer asks.

1. Quit vaexcore console.
2. Remove:

   ```text
   ~/Library/Application Support/vaexcore console
   ```

3. Reopen vaexcore console and run `Settings -> Setup Guide` again.
