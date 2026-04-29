# VaexCore Security Notes

VaexCore is designed as a local-first Twitch bot. The setup/operator console must stay bound to `127.0.0.1` and is not intended for public hosting.

## Secrets

- Do not commit `.env`, `config/local.secrets.json`, SQLite databases, logs, or packaged runtime data.
- OAuth access tokens, refresh tokens, client secrets, and OAuth codes must not be posted in chat, logs, audit metadata, screenshots, or issue reports.
- The setup API only returns safe config status and masked token status.

## Local Console

- The setup server rejects non-local socket addresses and non-localhost `Host` headers.
- Browser responses include basic hardening headers and disable caching.
- Keep `Echo command to chat` off unless you intentionally want the UI action mirrored in Twitch chat.

## Twitch Chat Threat Model

VaexCore treats chat input as untrusted. Commands are bounded, normalized, permission checked, and rate limited. Unknown commands are ignored. Denied commands do not return sensitive details.

## Resetting Local State

Development mode stores local secrets in:

```text
config/local.secrets.json
```

The macOS app stores local secrets and SQLite data under the app data directory:

```text
~/Library/Application Support/VaexCore
```

Quit VaexCore before deleting or moving these files.
