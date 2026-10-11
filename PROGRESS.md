# PROGRESS

Resume file for Batman. A fresh Claude Code session must be able to continue from this file alone.
Spec: docs/BATMAN_SPEC.md. Decisions: DECISIONS.md. Verified APIs: docs/PHOTON_NOTES.md.

## Current phase
DEPLOYED: Batman runs on Fly.io (app batman-safety, machine 863669fee9e558, iad) since 2026-10-11 02:19 UTC; logs show "Batman is listening". Do NOT run pnpm dev locally against the Batman project while it runs.
All code merged; pnpm verify green (1066 tests + 1 expected-fail). Safety review findings all fixed. index.ts wires the dialogue manager to app.ts.
Landing page: separate repo https://github.com/markandeyay/batmanlandingpage cloned at C:\Users\yalam\batmanlandingpage (Vite + GSAP + Lenis, inspired by markandeyay/stussy = stussy.ink, light and trustworthy). Brand and motion design agents running; builder next. Sign-up API (Vercel function) will register a phone on the Photon project and return the personal Batman number + sms link.
Redeployed 2026-10-11 03:36 UTC with live UX fixes (time edits, personality, read receipts).
Next: live onboarding from the human iPhone against the cloud server; second safety-reviewer pass on the gateway and index.ts; guided iPhone session (16.4); README demo notes; landing page (separate repo, human to provide stuci.ink repo).
Ops: logs via flyctl logs -a batman-safety; redeploy via flyctl deploy --ha=false --remote-only -a batman-safety (flyctl.exe is under %LOCALAPPDATA%MicrosoftWinGetPackagesFly-io.flyctl_*).

## Done (2026-10-10)
- Repo, .gitignore, .gitattributes, CLAUDE.md, .claude/settings.json, .claude/agents/*.md (spec 13). Deny rule narrowed so .env.example is readable.
- Toolchain ok (node 24.13, pnpm 12.9.1, git 2.53, ffmpeg 8.0.1). `pnpm run doctor` passes ("run" is required; pnpm has a built-in doctor).
- .env filled through local pages (scratchpad scripts, never committed). Present: Photon project + secret, BATMAN_LINE_E164 (pool number assigned to the human's iPhone), IMESSAGE_GRPC_ADDRESS=imessage.spectrum.photon.codes:443, ANTHROPIC_API_KEY (LLM), OPENAI_API_KEY (speech), STT/TTS models, LiveKit URL/key/secret, LIVEKIT_SIP_TRUNK_ID (Batman's own trunk), probe project id + secret, HUMAN_IPHONE_E164, TEST_GUARDIAN_E164.
- Photon: project e0a7b9f4-... is a shared pool; human iPhone registered as a user. Probe project ed2b4211-... created via CLI.
- LiveKit: trunk `batman-photon` (ST_NvuRQfn2m5aR) -> sip.spectrum.photon.codes:5061 TLS, created by scripts/livekit-setup.ts. Another trunk "ATP demo" (Plivo, other project) exists and must stay untouched.
- docs/PHOTON_NOTES.md written by docs-researcher (13 spec mismatches, 8 open questions; key: use createGrpcClient from @photon-ai/advanced-imessage/grpc; guardians must be registered via POST /users/ before Batman can message them on a shared pool).
- apps/server/src/contracts.ts: shared types, EngineEvent, Effect, TemplateId, Channel, CallService, LocationSource. Pure engine plus effects architecture (DECISIONS.md).
- docs/spikes/S2.md: install half PASS (rtc-node loads on Windows), SIP host reachable over TLS 5061 and TCP 5060. Call test not yet run.

## Spike outcomes (docs/SPIKES.md)
- S1 PASS (Find My works on shared pool once the user has texted Batman first; movement tracked live). S2 partial (LiveKit path works; live call pending). S3 not tested (text-only). S4 FAIL for native pins (use typed address or Maps link). S5 guardians must be registered and must text Batman first. S6 FAIL (live testing = guided iPhone + pnpm chat + sim).
- Text-only mode: OpenAI key invalid and disabled in .env. Calls ring with a tone; guardian alerts are text only.
- Host PC entered Modern Standby during a test; keep lid open and plugged in for demos.

## Next
1. Restart (with the human's go-ahead): S1, S3+S4, S5+S6, and a new S2 call spike (integration-engineer each); core-engineer and conversation-engineer in fresh worktrees from main. Briefs: see the session transcript or rebuild from spec 13.3/13.4 plus DECISIONS.md (voice enabled, Anthropic LLM, contracts.ts frozen).
2. Batch all iPhone steps (accept Find My, walk, answer call, send voice note, send pin, send "ping") into one checklist.
3. Record PASS/FAIL and branches in docs/SPIKES.md and DECISIONS.md, then Phase 1 gateway wiring.

## Notes for a fresh session
- Photon CLI: `npx -y @photon-ai/cli <cmd> --project <id>` (human is logged in).
- pnpm 12: build approvals live in pnpm-workspace.yaml under allowBuilds.
- Never message the insurer, doctor, or payer numbers that appeared in pasted notes from another project.
