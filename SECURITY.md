# vaexcore console Security Notes

vaexcore console is designed as a local-first Twitch bot. The setup/operator console must stay bound to `127.0.0.1` and is not intended for public hosting.

## Secrets

- Do not commit `.env`, `config/local.secrets.json`, SQLite databases, logs, or packaged runtime data.
- OAuth access tokens, refresh tokens, client secrets, and OAuth codes must not be posted in chat, logs, audit metadata, screenshots, or issue reports.
- The setup API only returns safe config status and masked token status.

## Local Console

- The setup server rejects non-local socket addresses and non-localhost `Host` headers.
- Browser responses include basic hardening headers and disable caching.
- Keep `Echo command to chat` off unless you intentionally want the UI action mirrored in Twitch chat.
- Keep new major modules in `test` until they behave correctly in local simulation. `test` mode must not respond to Twitch chat.

## Audit And Diagnostics

- Audit metadata is redacted before storage and redacted again before diagnostics or support exports.
- vaexcore console keeps the latest 1,000 audit rows for up to 90 days by default.
- Diagnostics and support bundles should explain state and next action without exposing local secrets.

## Twitch Chat Threat Model

vaexcore console treats chat input as untrusted. Commands are bounded, normalized, permission checked, and rate limited. Unknown commands are ignored. Denied commands do not return sensitive details.

Moderation filters are feature-gated, local, and warn-only. They do not ban users, do not use public blocklists, and do not call Twitch moderation APIs. Protected commands and active giveaway entry commands are exempt so core operations continue even if a filter is configured too aggressively.

## Resetting Local State

Development mode stores local secrets in:

```text
config/local.secrets.json
```

The macOS app stores local secrets and SQLite data under the app data directory:

```text
~/Library/Application Support/vaexcore console
```

Installs updated from older pre-rename builds may continue using the existing legacy app data directory. Diagnostics shows the active config path.

Quit vaexcore console before deleting or moving these files.
