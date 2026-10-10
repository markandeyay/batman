# DECISIONS

Log of design decisions, spec deviations, and spike-driven branch choices. Newest at the bottom.
Format: date, decision, why, spec section affected.

## 2026-10-10: Toolchain already present, no winget installs
- Node v24.13.0, pnpm 12.9.1 (via corepack), Git 2.53, ffmpeg 8.0.1 were already installed. Spec Section 14 Phase 0a satisfied without installing anything. FFMPEG_PATH is optional since ffmpeg is on PATH.

## 2026-10-10: Settings permission rules kept verbatim
- .claude/settings.json uses spec Section 13.2 rules unchanged. If a later Claude Code version rejects a rule, fix syntax but keep the intent: allow normal project commands, deny reading any .env file.
