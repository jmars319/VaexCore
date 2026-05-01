# Changelog

## 0.1.0 - Local unsigned tester build

Current release state: usable local Twitch operator console with unsigned macOS tester packaging.

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
