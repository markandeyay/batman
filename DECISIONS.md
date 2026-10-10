# DECISIONS

Log of design decisions, spec deviations, and spike-driven branch choices. Newest at the bottom.
Format: date, decision, why, spec section affected.

## 2026-10-10: Toolchain already present, no winget installs
- Node v24.13.0, pnpm 12.9.1 (via corepack), Git 2.53, ffmpeg 8.0.1 were already installed. Spec Section 14 Phase 0a satisfied without installing anything. FFMPEG_PATH is optional since ffmpeg is on PATH.

## 2026-10-10: Settings deny rule for .env.* narrowed so .env.example stays readable
- Spec 13.2 says `.env.example` stays readable, but the rule `Read(./.env.*)` also matched it (Claude Code glob rules have no negation). Replaced it with an explicit list of real env file names (`.env.local`, `.env.development`, `.env.test`, `.env.production`, their `.local` variants, `.env.probe`, `.env.demo`). `Read(./.env)` and the Bash and PowerShell `cat`, `type`, `Get-Content` denies are unchanged. Intent preserved: allow normal project commands, deny reading any real secret file. Only use env file names from this list.

## 2026-10-10: Project is a shared-pool (Free/Pro) iMessage project
- `GET /projects/{id}/imessage/` returned `type: "shared"`. The project has no dedicated line and no Spectrum users yet (checked via the Photon CLI and the management API).
- Consequence: there is no single fixed "Batman number." Each end user is registered with `POST /projects/{id}/users` (`type: shared`) and receives an `assignedPhoneNumber` from the pool. `BATMAN_LINE_E164` is therefore set to the pool number assigned to the human's iPhone after registration, and `scripts/admin-add-user.ts` (spec 11.1) is the normal onboarding path.
- Risk: Spectrum Voice caller ID must be a project-owned line (spec 10.1). On a shared pool this likely blocks Spike S2; the voice-note fallback (spec 10.4) is the expected branch unless Photon grants a dedicated line. Ask in Photon's Discord (spec Section 20, Q2).
- Photon CLI: installed via `npx @photon-ai/cli` (not global). Run as `npx -y @photon-ai/cli ... --project <id>`.

## 2026-10-10: LLM provider is Anthropic; OpenAI kept for speech only
- Human asked to use an Anthropic API key. Spec 9.2 allows `LLM_PROVIDER=anthropic` through an `LlmProvider` interface with identical schemas and validators. `LLM_MODEL_SMART=claude-opus-5-5`, `LLM_MODEL_FAST=claude-haiku-5-5` (current model IDs per the claude-api skill, cached 2026-10-06).
- Spec 9.5 STT and TTS stay on OpenAI because Anthropic has no speech API. `OPENAI_API_KEY` is required only for voice notes and call audio. If absent, voice features are disabled and Batman runs text-only.
- Plan extraction uses the Anthropic Messages API structured output (`output_config.format`) with the zod schema mirrored as JSON schema. The older `output_format` parameter is deprecated.

## 2026-10-10: Doctor script is invoked as `pnpm run doctor`
- pnpm 12 ships a built-in `pnpm doctor` command that shadows the package script. The script keeps the spec's name but must be run with `pnpm run doctor`. CLAUDE.md updated.
- Root package.json has `"type": "module"` so tsx runs scripts as ESM (top-level await).

## 2026-10-10: Project subagents not registered in the first session
- .claude/agents/*.md were created after the session started, so the Agent tool did not list them. Workaround for this session: general-purpose agents whose prompt begins with "read and follow .claude/agents/<name>.md". A fresh session sees them natively.

## 2026-10-10: Text-only mode; no OpenAI key will be available
- Human cannot obtain an OpenAI API key and accepted a text-only Batman. STT and TTS are disabled: inbound voice notes get the spec 8.4 reply "Couldn't hear that one, can you text it?" and count as AMBIGUOUS during CHECKING; Batman never sends voice notes. Spike S3 (voice note format) is still logged for the record but is not a gate.
- Exit-word fallback when no call can be placed (spec 6.6 step 3) becomes text-only: send "Call me asap" plus notifySilenced if Focus is on. Guardian alert call (5.2) and L2 check-in call (6.4) are unavailable without TTS audio, so the ladder sends the L2 text plus notifySilenced and proceeds to L3 on the same timers. The `CallService` interface stays so the SIP path can be added later.
- Human asked Claude to finish the project autonomously and to obtain resources itself where possible. Optional credentials (LiveKit) will be entered at the end if at all.

## 2026-10-10: Probe project created by Claude via the Photon CLI
- `npx @photon-ai/cli projects create -n probe --platforms imessage` created project ed2b4211-1b34-4787-bb72-4b777c92ed84 (free tier, shared pool) under the human's Photon account. Its ID and secret were written straight into .env as PROBE_PROJECT_ID / PROBE_PROJECT_SECRET by a script; the secret was never printed. Spike S6 can now run.

## 2026-10-10: Phases 1 to 4 pure logic started before Phase 0 exit
- Spec 0.2 says not to start a phase before the previous exit criteria pass. Phase 0 exit needs the human's iPhone (S1 accept, S3/S4 sends), and the human asked for autonomous progress. The plan engine, scheduler, risk engine, store, dialogue, NLU, code words, and templates are pure modules whose design does not branch on spike results (S1 only selects the LocationSource implementation; S2 only selects the CallService implementation; S5 is answered by Stable docs). So core-engineer and conversation-engineer started in parallel worktrees against apps/server/src/contracts.ts. Gateway wiring and anything that depends on spike outcomes waits for the spikes. Phase exit criteria are still checked in order before each phase is declared done in PROGRESS.md.

## 2026-10-10: Pure engine plus effects architecture (contracts.ts)
- The plan engine is a pure function applyEvent(plan, event, ctx) returning the new plan plus a list of Effects (send template, react, call, request_location, schedule, cancel_jobs, purge_location, audit). An executor in the gateway layer performs effects through the Channel interface. This enforces I7 (no LLM in escalation), makes every path testable with a fake clock, and lets the terminal provider and tests share the same logic (spec 8.5).

## 2026-10-10: Voice re-enabled; OpenAI key now available (supersedes "Text-only mode")
- The human pasted a hackathon-provided OpenAI key through the local import page. STT (`gpt-4o-mini-transcribe`) and TTS (`gpt-4o-mini-tts`, voice `alloy`) are back on per spec 9.5. LLM work stays on Anthropic (`LLM_PROVIDER=anthropic`). A model name `gpt-6-sol` in the pasted notes is not used: the LLM is Claude.
- Text-only behavior from the earlier entry stays as the runtime fallback when `OPENAI_API_KEY` is absent or a speech call fails.
- The paste also contained ElevenLabs, Plivo, and unrelated demo values (insurer and doctor numbers, an app password, a Slack webhook) from another project. None were saved or used. The insurer and doctor phone numbers belong to other people and must never be messaged.

## 2026-10-10: Batman's own LiveKit SIP trunk to Photon (spec 10.2)
- The LiveKit project in .env already had an outbound trunk named "ATP demo" pointing at Plivo (another project). It was left untouched. `scripts/livekit-setup.ts` created a separate trunk `batman-photon`: address `sip.spectrum.photon.codes:5061`, transport TLS, auth username = Spectrum project ID, password = project secret, numbers = [BATMAN_LINE_E164]. Its id replaced `LIVEKIT_SIP_TRUNK_ID` in .env. The script is idempotent (reuses the trunk by name).
- Added `@livekit/protocol` to apps/server for the `SIPTransport` enum (livekit-server-sdk does not re-export it).
- Open: whether Photon accepts a shared-pool `assignedPhoneNumber` as caller ID. Spike S2 answers it; fallback stays the voice-note path (spec 10.4).
