# PROGRESS

Resume file for Batman. A fresh Claude Code session must be able to continue from this file alone.
Spec: docs/BATMAN_SPEC.md. Decisions: DECISIONS.md.

## Current phase
Phase 0a (environment). Waiting on the human to create .env from .env.example.

## Done
- 2026-10-10: git repo initialized on main, origin = https://github.com/markandeyay/batman.git (remote was empty).
- 2026-10-10: .gitignore, .gitattributes, docs/BATMAN_SPEC.md committed and pushed.
- 2026-10-10: CLAUDE.md, .claude/settings.json, .claude/agents/*.md created verbatim from spec Section 13, pushed.
- 2026-10-10: Phase 0a toolchain check. All present, nothing installed:
  node v24.13.0 (LTS), corepack 0.34.5, pnpm 12.9.1, git 2.53.0.windows.1, ffmpeg 8.0.1 (gyan.dev full build, on PATH), winget 1.29.380.
- 2026-10-10: .env.example created from spec Section 19.

## Next
1. Human fills .env (see .env.example). Never read or print .env.
2. Phase 0a remainder: pnpm workspace skeleton + scripts/doctor.ts so `pnpm doctor` verifies env presence (names only) and Photon auth (GET /projects/{id}/).
3. docs-researcher subagent verifies Photon, LiveKit, OpenAI APIs into docs/PHOTON_NOTES.md.
4. Phase 0b spikes S1 to S6 in parallel (integration-engineer per spike); batch iPhone steps into one checklist.

## Blockers
- .env not yet created by the human.

## Notes for a fresh session
- Spec file was delivered as "BATMAN_SPEC (1).md" and renamed before the first commit.
- Settings permission rules from spec 13.2 were accepted as written; no syntax changes needed so far.
