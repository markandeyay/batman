# PROGRESS

Resume file for Batman. A fresh Claude Code session must be able to continue from this file alone.
Spec: docs/BATMAN_SPEC.md. Decisions: DECISIONS.md.

## Current phase
Phase 0a nearly done. Starting Phase 0 research (docs-researcher) and then Phase 0b spikes.

## Done (2026-10-10)
- Git repo on main, origin = https://github.com/markandeyay/batman.git. .gitignore, .gitattributes, docs/BATMAN_SPEC.md pushed.
- CLAUDE.md, .claude/settings.json, .claude/agents/*.md from spec Section 13. Deny rule narrowed so .env.example is readable (see DECISIONS.md).
- Toolchain verified, nothing installed: node v24.13.0, pnpm 12.9.1, git 2.53, ffmpeg 8.0.1 on PATH.
- .env created by the human through a local setup form (scratchpad script, not in repo). Set: SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, BATMAN_LINE_E164, ANTHROPIC_API_KEY, LLM_* (anthropic, claude-opus-5-5 / claude-haiku-5-5), STT/TTS model names, HUMAN_IPHONE_E164, TEST_GUARDIAN_E164, GEOCODER=nominatim, DATABASE_PATH, DEFAULT_TZ, runtime defaults.
  Blank: OPENAI_API_KEY (voice disabled until set), LIVEKIT_*, PROBE_PROJECT_*, IMESSAGE_GRPC_ADDRESS.
- Photon project e0a7b9f4-1eff-40ba-8715-bb1d5737f062 is type "shared" (pool). Human iPhone registered via POST /projects/{id}/users/ (type shared); assignedPhoneNumber written to BATMAN_LINE_E164. Spectrum API auth works.
- pnpm workspace scaffolded: package.json (scripts per CLAUDE.md), pnpm-workspace.yaml (apps/*, allowBuilds for native deps), apps/server and apps/probe package.json with all SDKs installed. better-sqlite3 and @livekit/rtc-node load on Windows x64 (S2 install question answered: yes).

## Next
1. docs-researcher subagent: verify Photon (Stable), LiveKit, Anthropic, OpenAI speech APIs against installed node_modules types and docs. Output docs/PHOTON_NOTES.md.
2. scripts/doctor.ts (pnpm doctor): toolchain, env presence (names only), Photon auth GET /projects/{id}/.
3. Phase 0b spikes S1 to S6 in parallel (integration-engineer each). Batch iPhone steps into one checklist for the human. S2 and S6 blocked until LiveKit and probe credentials exist; record as such if still blank.

## Blockers / waiting on human
- Optional .env values: OPENAI_API_KEY (voice), LIVEKIT_URL/KEY/SECRET (S2 calls), PROBE_PROJECT_ID/SECRET (S6 probe).

## Notes for a fresh session
- Photon CLI is not global: use `npx -y @photon-ai/cli <cmd> --project e0a7b9f4-1eff-40ba-8715-bb1d5737f062`. Human is logged in.
- pnpm 12 ignores the "pnpm" key in package.json; build approvals live in pnpm-workspace.yaml under allowBuilds.
