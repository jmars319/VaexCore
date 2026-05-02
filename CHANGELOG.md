# Changelog

## Unreleased

- Milestone 45: viewer-facing utility command presets with categorized starter commands, disabled utility packs for common channel/support commands, conflict-aware pack creation, UI pack controls, and expanded custom command smoke coverage.
- Milestone 44: operator-grade moderation filter polish with boundary-aware blocked phrase matching, intentional wildcard phrases, blocked link domains, clearer local test enforcement plans, recent hit summaries by filter/action, and expanded smoke coverage.
- Milestone 43: activity-aware timers with per-timer non-command chat message thresholds, UI activity progress, activity-blocked explanations, timer export/import versioning, live-ready EventSub activity counting, and smoke coverage proving timers wait for eligible chat before queueing.
- Milestone 42: scoped moderation enforcement with per-filter warn/delete/timeout actions, optional Twitch moderation scopes, fail-open enforcement planning, audit entries for blocked/succeeded/failed actions, UI capability status, and smoke coverage for missing-scope and protected-command behavior.

## 0.1.2 - Bot replacement readiness release

Current release state: unsigned tester release for local bot replacement rehearsal and stream-ready feature gates.

- Milestone 41: neutral bot replacement release cut with no third-party bot naming in UI, docs, scripts, or release logs, plus a packaged-app release rehearsal for the 0.1.2 unsigned tester artifact.

## 0.1.1 - Versioned unsigned tester release

Current release state: clean-main unsigned tester cut for wider local testing.

- Milestone 40: release/tester readiness for the bot replacement feature wave with an integrated smoke covering stream presets, starter commands, timer presets, moderation rehearsal, live confirmation guards, protected giveaway commands, and tester guide updates.
- Milestone 39: stream-night presets for audited feature-gate bundles covering giveaway-only operation, local bot rehearsal, timers-live mode, and full local bot replacement mode with explicit live-feature confirmation and smoke coverage.
- Milestone 38: command ergonomics with disabled starter presets for common streamer utility commands, preset conflict inspection, UI creation flow, local service reuse, and expanded custom command smoke coverage.
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
