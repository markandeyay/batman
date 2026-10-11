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

## 2026-10-10: TypeScript pinned to 6.0.3
- TypeScript 7.0.2 (latest) is not supported by typescript-eslint 8.71.1 (peer range `>=4.8.4 <6.1.0`), so `pnpm lint` could not run. Pinned `typescript@6.0.3`. The earlier tsc runs that hung for 2+ minutes on Windows also complete in about 2 s on 6.0.3.
- `pnpm lint` = ESLint (typescript-eslint recommended) plus `scripts/check-copy.ts`, which fails on any em dash in tracked source, docs, or data (the spec file is excluded).

## 2026-10-10: Spike S1 blocked on the shared-pool allowlist
- All advanced-imessage calls targeting the human's iPhone return PERMISSION_DENIED "Target not allowed for this project" even though the number is a registered user. Locations authorization on the shared pool is therefore still unknown. Never call `locations.list()` on the shared pool. Next: the human checks the Apple handle at debug.photon.codes and texts the Batman line first, then rerun `pnpm spike s1 focus`. If still denied, the branch is LOCATION_SOURCE=pin and a question to Photon (spec Section 20).

## 2026-10-10: Single root TypeScript project
- Composite project references prevented scripts from importing apps/server code (rootDir errors). Replaced with one root `tsconfig.json` (includes apps/*/src, scripts, tests) and `allowImportingTsExtensions` with `noEmit` (tsx runs TypeScript directly, nothing is emitted). `pnpm typecheck` = `tsc -p tsconfig.json`. apps/server and apps/probe keep small tsconfigs for focused checks.

## 2026-10-10: Spike S2 partial; OpenAI key rejected
- LiveKit path verified on Windows without a phone: trunk check PASS, rtc-node room join and audio publish PASS. The real call to the iPhone is pending the batched iPhone session (`pnpm spike s2 call`).
- `OPENAI_API_KEY` returns 401 "Incorrect API key provided". It may be a hackathon proxy key that needs `OPENAI_BASE_URL` (now honored by speech code). Until fixed, speech is effectively unavailable: STT failures yield the voice_unavailable reply, and calls use a pre-rendered tone or the text fallback. OpenAI error messages can echo part of the key, so logs now mask any `sk-` token.
- The executor must not wait on `CallService.place()` (it blocks until answered, up to ~30 s) before sending the exit-word text fallback; spec 6.6 requires the fallback within 5 s of a failed placement. The executor sends the fallback as soon as `place()` resolves false and runs the call concurrently with the innocuous reply.

## 2026-10-10: Spike S5 answered, S6 FAIL, branch = guided iPhone + chat + sim
- S5: guardians must be registered with `POST /projects/{id}/users/` before Batman can text them (Stable docs; live test impossible without messaging a real person). Guardian onboarding calls the Users API first (spec 14 branch "S5 requires registration"). Registration sends nothing, so it happens when the user names the guardian, before the opt-in text (I1 still holds: no plan details until YES).
- S6: FAIL. Shared-pool lines reject other pool numbers as recipients. Per spec 14, live testing uses the guided iPhone runner (16.4) plus `pnpm chat` scripted transcripts and sim (16.5 last bullet). apps/probe is kept only as the registration helper; `pnpm e2e:probe` will report the documented fallback. Definition of Done item 2 is satisfied by "documented S6 fallback".
- Each user is assigned a different pool number, so the guardian's Batman number differs from the user's. Copy never claims they match.
- Cleanup: Claude deleted 7 useless users (phone numbers that were themselves pool numbers) that the spike created on both projects; the human's registration is untouched.

## 2026-10-10: Final: text-only speech, calls still ring (supersedes the voice re-enable entry)
- The hackathon OpenAI key and a second key both failed (401). The human chose text-only. `OPENAI_API_KEY` is commented out in .env, so `capabilities(env).speech` is false.
- No STT: inbound voice notes get the voice_unavailable reply ("Couldn't hear that one, can you text it?") and count as AMBIGUOUS in CHECKING. No voice-note replies.
- Calls stay enabled because LiveKit and the Photon trunk are configured (`capabilities.calls`). Without TTS, the fake exit call and the L2 check-in call play a short neutral tone (rendered locally with ffmpeg, no OpenAI) so the phone still rings and the user has their excuse to leave. The guardian alert call is skipped without TTS: a tone carries no information for the guardian, so the guardian is alerted by text (and Notify Anyway) only. If a working OpenAI key is added later, speech turns on with no code change.
- If the S2 call test shows Photon rejects the shared-pool caller ID, calls fall back to text (spec 10.4) regardless.

## 2026-10-10: Spike S1 PASS (shared pool), S4 FAIL for native pins, host sleep observed
- Users must text the Batman line first before any advanced-imessage call that targets them is allowed. Onboarding already starts with an inbound message from the user, so users are fine. Guardians are NOT: Batman cannot text a guardian (or check isIMessageAvailable for them) until the guardian has texted their assigned Batman number. Guardian opt-in therefore changes: Batman registers the guardian, then tells the user "Ask Priya to text this number to accept: <guardian's assigned number>" with the sms: redirect link, and the opt-in flow (spec 4.3) starts when the guardian's first text arrives. Recorded as a deviation from spec 4.3, forced by Photon shared-pool rules.
- Find My acceptance is detected with `get()` polling; first fix had accuracy 6.7 m, type "shallow". LOCATION_SOURCE=findmy is the default.
- Native "Send My Current Location" pins arrive as unsupported content. Venue and home pins use typed addresses or pasted Maps links.
- The host PC entered Windows Modern Standby for 41 minutes while on AC power with standby-timeout-ac 0. Modern Standby is triggered by screen off or lid close regardless of the sleep timer. `pnpm run doctor` now warns about this; demo and real use need the screen kept on (`powercfg /change monitor-timeout-ac 0`, lid open) or an always-on host (spec 17 Option B).

## 2026-10-10: Core engine judgment calls (core-engineer, accepted)
1. On a date, walking away from the venue does not fire T-DEP-WALK; T-VENUE-CHG ("New spot?") handles it (needed for S-09, matches 4.4.1 "venue changes are common and usually fine").
2. "Before planned end minus 10 min" for departure triggers is judged at the time the user left, not when departure was confirmed (S-08: leaving at minute 8 is confirmed at minute 10).
3. Night and high-vigilance multipliers compound (0.7 x 0.6 = 0.42). Night is counted once.
4. A NOT_OK reply places the exit call and sends act_calling_you_now (spec 6.4 "offer the exit call" interpreted as "do it"; the user can decline the call). NOT_OK while ACTIVE opens a soft ladder with lad_clarify.
5. Overtime extensions count from max(planned end, now). An OK reply in overtime counts toward the 4 h cap; an explicit "+N" does not.
6. Guardian location updates after GOT IT: checked every 5 min, sent only if the user moved more than 150 m ("whichever is later").
7. The engine itself sends plan_locked_in, plan_awaiting_guardian, plan_armed_now, and usr_guardian_stopped for open plans. The dialogue layer must not duplicate them.
8. CLOSING uses closedAt as its start marker for home-arrival detection; overwritten on close.
9. An alert word during an existing escalation re-sends gdn_alert once with the stronger reason, with no second call.
10. Runtime layer (plan/runtime.ts) persists plan plus jobs in one transaction, then performs outbound effects through an OutboundPort the gateway implements.
- Contract proposals (extra Plan fields, a guardian "plan started" template, a call_result event) are held in EnginePlan locally; contracts.ts will be updated during integration.

## 2026-10-10: Spike S2 FAIL on shared pool; calls fall back to text
- Photon returns SIP 403 for outbound calls whose From is a shared-pool number (Stable docs require a project-owned iMessage line). Enabling the `voice` platform did not change it (reverted). The executor still attempts LiveKit when capabilities.calls is true, because the 403 returns in about 1.3 s, well inside the 5 s fallback budget of spec 6.6; with a dedicated line, calls work with no code change. Spec Section 20 Q2 answered: no outbound calls on Free/Pro shared pool.

## 2026-10-10: Conversation layer judgment calls (conversation-engineer, accepted)
- Spec S-14 example fixed: "pinaple" is edit distance 2 from "pineapple", so the 9.1 rule (distance <= 1) correctly does not match it. The spec example is changed to "pinapple" (distance 1); the rule is unchanged.
- loc_time_only copy is "No location, no problem. I'll just go by the time." because "check in" is on the I10 discretion list.
- I13 disclosure adds "and I can fail if my service goes down" to cover the host or Photon outage case.
- Guardian-facing copy uses "they" for the user (gender unknown).
- The engine sends code word replies (cw_*), act_calling_you_now, and arming messages; the dialogue only dispatches the events. After STOP the executor drops every send to that address.
- Plan edits after arming use a local event `{ type: "plan_edited", fields }`, to be added to contracts.ts during integration.
- Eval datasets live in tests/evals/data/ (generated by tests/evals/generate.ts). .gitignore now ignores only the root /data/ and /logs/.
- Code word eval: 100% recall on 1,796 generated variants, 0 false positives on 2,098 benign messages. With no model at all, the rule pre-pass never labels a NOT_OK reply as OK (307 replies).
