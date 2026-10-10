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
