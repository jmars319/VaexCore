# vaexcore console Development Guidelines

These rules guide future vaexcore console milestones. vaexcore console is local stream operations software, so reliability, safety, and recovery matter more than broad feature count.

## Core Stability

Giveaways, command routing, Twitch transport, persistence, auth, and outbound message reliability are core systems. New features must not rewrite or destabilize them unless the milestone is explicitly core maintenance.

New functionality should be additive, modular, and removable. A failed optional feature must not prevent bot startup, chat connection, giveaways, custom commands, diagnostics, or operator console access.

Chat commands, UI actions, simulations, and tests should call the same service layer. Do not duplicate business logic between those surfaces.

## Operator Console

The UI is a local operator console, not a public dashboard. Prioritize clarity, safety, and recovery over visual flair. Every operator flow should assume the streamer is live, distracted, and managing chat.

Prefer disabled unsafe buttons, confirmations for destructive actions, clear next actions, recovery paths, and concise statuses. Stop when the workflow is reliable; do not add polish that increases maintenance cost without improving live operation, safety, or recovery.

Keep live mode and test mode distinct. Testing and simulation tools must be clearly labeled. Live-mode actions should not silently use fake data, and test tools should not imply real Twitch delivery unless it happened.

## Local-First Security

Local-first remains non-negotiable. Do not assume hosted SaaS, and do not expose a control surface to the internet. Bind local tools to localhost and keep secrets local.

Never expose tokens, client secrets, refresh tokens, OAuth codes, or local config contents in UI responses, logs, audit logs, diagnostics bundles, exported files, or error messages.

Prefer explicit failure over silent failure. If something is degraded, blocked, disconnected, expired, or unsafe, surface it clearly with an actionable next step.

## Giveaways

Giveaways remain protected. Any new feature must be checked against giveaway state integrity, winner uniqueness, delivery tracking, auditability, and outbound message reliability.

Every path that sends chat messages must respect the outbound queue and rate-limit handling. No feature should send directly to Twitch outside the approved send layer.

## Custom Commands

Custom commands must stay sandboxed. They must not override protected built-ins unless a deliberate override mechanism is added with warnings, recurse infinitely, bypass cooldowns, bypass permissions, leak secrets, produce unsafe or huge output, or spam chat through aliases or variants.

Protected system commands outrank user-defined commands. Built-ins win over custom commands unless a future milestone explicitly adds a warned override mechanism.

## Governance

New major modules should be isolated behind feature gates until they are tested. Prefer `off`, `test`, and `live` states so a feature can be validated locally even during a stream before it is allowed to affect Twitch chat.

Actions that affect giveaways, commands, messages, settings, release/update state, diagnostics, or feature gates should write bounded, redacted audit entries.

Maintain CLI fallback. The macOS app is primary for convenience, but CLI and setup scripts should remain functional for recovery and debugging.

Preserve release discipline. Every milestone should run typecheck, build, relevant smoke tests, and packaged app smoke tests when packaging is affected.

Diagnostics should answer what failed, what state the system was in, and what the operator should do next. Diagnostics must not expose secrets.

Prefer boring, inspectable code. Avoid clever abstractions unless they reduce real duplication or risk.
