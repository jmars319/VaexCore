# Changelog

## 0.1.1 - Versioned unsigned tester release

Current release state: clean-main unsigned tester cut for wider local testing.

- Milestone 39: stream-night presets for audited feature-gate bundles covering giveaway-only operation, Nightbot rehearsal, timers-live mode, and full Nightbot replacement mode with explicit live-feature confirmation and smoke coverage.
- Milestone 38: command ergonomics with disabled starter presets for common Nightbot-style commands, preset conflict inspection, UI creation flow, local service reuse, and expanded custom command smoke coverage.
- Milestone 37: moderation filters v2 with trusted-role exemptions, allowed link domains, temporary link permits, richer moderation state summaries, UI controls, audited operator actions, and expanded smoke coverage.
- Milestone 36: timer live polish with preset starters, timer JSON import/export, richer live-readiness checks, next-action explanations for blocked or scheduled timers, and expanded timer smoke coverage.
- Milestone 35: giveaway live-readiness audit with a stream-night rehearsal smoke for chat and UI lifecycle paths, duplicate entries, insufficient entrants, reroll, manual claim/delivery, restart persistence, audit logs, outbound assurance, and custom command/timer/moderation interference checks.
- Milestone 34: basic feature-gated moderation filters with blocked phrases, link/caps/repeat/symbol checks, warn-only queue-owned responses, protected command and giveaway entry exemptions, recent hit history, audit logging, local simulation, and smoke coverage.
- Milestone 33: feature-gated chat timers with local definitions, enable/disable without deletion, minimum intervals, live-readiness and outbound-queue guardrails, queue-owned delivery, last/next fire status, audit logging, and smoke coverage for no-spam and feature-gate behavior.
- Milestone 32: operational guardrails with documented development rules, protected command registry, feature gates for off/test/live module rollout, bounded redacted audit retention, custom command secret checks, diagnostics visibility, and smoke coverage.
- Milestone 31: custom command center with local command definitions, aliases, permissions, cooldowns, response variants, usage history, import/export, audit logging, runtime fallback handling, and smoke coverage.
- Milestone 30: versioned tester release cut with clean-main release guard, full git SHA manifests, tester handoff notes, and rebuilt unsigned artifacts.

## 0.1.0 - Local unsigned tester build

Current release state: usable local Twitch operator console with unsigned macOS tester packaging.

- Milestone 29: tester update polish with visible build/version diagnostics, manual update guidance, and packaged-app preservation smoke for existing local setup and SQLite data.
- Milestone 28: real tester dry run that extracts the unsigned zip, launches the packaged app with isolated app data, and verifies setup UI, diagnostics, support bundle redaction, and packaged SQLite.
- Milestone 27: tester onboarding guide with unsigned launch steps, setup checklist, support bundle handoff, and common fixes.
- Milestone 26: release discipline with changelog, metadata checks, known limitations, and a full unsigned release command.
- Milestone 25: unsigned macOS tester zip, SHA-256 checksum, manifest, and artifact smoke test.
- Milestone 24: support bundle, first-run recovery diagnostics, safer bot start readiness, and clean-install smoke coverage.
- Milestone 23: diagnostics panel and safe local diagnostics API.
- Milestones 21-22: automatic Twitch token refresh and CLI OAuth refresh bootstrap.
- Milestones 18-20: giveaway readiness hardening, queue recovery, live-mode guardrails, and stream-night verification.
- Milestones 8-17: modular setup UI, guided Twitch setup, bot runtime controls, giveaway announcements, live runbook, outbound history, operator messages, and post-stream review.

Known release limits:

- macOS arm64 tester artifact only.
- Ad-hoc signed, not Developer ID signed, and not notarized.
- Not intended for public distribution or SaaS hosting.
- Twitch credentials and OAuth tokens remain local-only.
