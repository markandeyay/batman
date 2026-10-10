# DECISIONS

Log of design decisions, spec deviations, and spike-driven branch choices. Newest at the bottom.
Format: date, decision, why, spec section affected.

## 2026-10-10: Toolchain already present, no winget installs
- Node v24.13.0, pnpm 12.9.1 (via corepack), Git 2.53, ffmpeg 8.0.1 were already installed. Spec Section 14 Phase 0a satisfied without installing anything. FFMPEG_PATH is optional since ffmpeg is on PATH.

## 2026-10-10: Settings permission rules kept verbatim
- .claude/settings.json uses spec Section 13.2 rules unchanged. If a later Claude Code version rejects a rule, fix syntax but keep the intent: allow normal project commands, deny reading any .env file.

## 2026-10-10: Project is a shared-pool (Free/Pro) iMessage project
- `GET /projects/{id}/imessage/` returned `type: "shared"`. The project has no dedicated line and no Spectrum users yet (checked via the Photon CLI and the management API).
- Consequence: there is no single fixed "Batman number." Each end user is registered with `POST /projects/{id}/users` (`type: shared`) and receives an `assignedPhoneNumber` from the pool. `BATMAN_LINE_E164` is therefore set to the pool number assigned to the human's iPhone after registration, and `scripts/admin-add-user.ts` (spec 11.1) is the normal onboarding path.
- Risk: Spectrum Voice caller ID must be a project-owned line (spec 10.1). On a shared pool this likely blocks Spike S2; the voice-note fallback (spec 10.4) is the expected branch unless Photon grants a dedicated line. Ask in Photon's Discord (spec Section 20, Q2).
- Photon CLI: installed via `npx @photon-ai/cli` (not global). Run as `npx -y @photon-ai/cli ... --project <id>`.
