# VaexCore Tester Guide

This guide is for early testers running the unsigned macOS build.

VaexCore is local-first. It runs on your Mac, stores Twitch setup locally, and opens a local operator console. It is not a public website or SaaS service.

## Before You Start

You need:

- A Mac with Apple silicon.
- The VaexCore unsigned zip.
- The matching `.zip.sha256` checksum file.
- A Twitch account for the bot. This can be the same as the broadcaster account, or a separate bot account.

This build is unsigned and not notarized. macOS may warn that the developer cannot be verified. Only run a build that came directly from the maintainer.

Before sharing the zip, the maintainer should have run the tester artifact dry run and tester update preservation check. Those dry runs launch the extracted app from the zip, check the local setup UI, confirm Diagnostics and support bundle redaction, verify packaged SQLite reports `better-sqlite3`, and prove an existing local setup survives app replacement.

## Install

1. Put the `.zip` and `.zip.sha256` files in `Downloads`.
2. Optional checksum check:

   ```bash
   cd ~/Downloads
   shasum -a 256 -c VaexCore-0.1.1-mac-arm64-unsigned.zip.sha256
   ```

3. Unzip the archive.
4. Move `VaexCore.app` to `/Applications`.
5. Open the app.

If macOS blocks the first launch:

1. Right-click `VaexCore.app`.
2. Choose `Open`.
3. Confirm `Open` again if macOS asks.
4. If there is no `Open` button, open `System Settings -> Privacy & Security`, scroll down, and choose `Open Anyway`.

## Updating VaexCore

When you receive a newer unsigned zip:

1. Quit VaexCore.
2. Unzip the new archive.
3. Replace the old `VaexCore.app` in `/Applications`.
4. Do not delete:

   ```text
   ~/Library/Application Support/VaexCore
   ```

5. Open VaexCore.
6. Open `Diagnostics -> About This Build` and confirm the version changed.

That Application Support folder is where Twitch setup, tokens, giveaway data, and local operator data live. Deleting it resets VaexCore.

## First Setup

Open `Settings -> Setup Guide` in VaexCore and follow the steps there.

The short version:

1. Create a Twitch Developer application.
2. Use this OAuth Redirect URL exactly:

   ```text
   http://localhost:3434/auth/twitch/callback
   ```

3. Save the Twitch Client ID and Client Secret in VaexCore.
4. Enter Broadcaster Login and Bot Login.
5. Click `Connect Twitch` while logged into the bot account.
6. Click `Validate Setup`.
7. Click `Send test message`.
8. Click `Start Bot`.
9. Type `!ping` in Twitch chat and confirm VaexCore sees live chat.

## Giveaway Test

Before using a real giveaway, run a tiny test:

1. Open `Giveaways`.
2. Start a giveaway with keyword `enter`.
3. Type `!enter` in Twitch chat.
4. Close entries.
5. Draw winner.
6. Confirm the app shows the entrant and winner.
7. End the giveaway.

Do not put prize codes into VaexCore. Deliver prizes manually outside the app.

## Send A Support Bundle

If something goes wrong:

1. Open `Diagnostics`.
2. Click `Copy support bundle`.
3. Paste it into a message to the maintainer.

The support bundle is designed to omit Twitch client secrets, access tokens, and refresh tokens.

## Known Errors And Fixes

### Port 3434 Is Busy

VaexCore uses `localhost:3434`. If the app says the port is already in use, quit other VaexCore windows first. If it still happens, restart the Mac or ask the maintainer for help with this command:

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

1. Quit VaexCore.
2. Remove:

   ```text
   ~/Library/Application Support/VaexCore
   ```

3. Reopen VaexCore and run `Settings -> Setup Guide` again.
