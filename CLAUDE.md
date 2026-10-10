# Batman: project instructions for Claude Code

Batman is an iMessage-only personal safety agent built on Photon. Full spec: docs/BATMAN_SPEC.md.
Read the relevant spec sections before any task. Resume state lives in PROGRESS.md.

## Environment
- Windows PC, native Claude Code with Git for Windows (Git Bash). Node LTS + pnpm.
- No Mac, no Messages app. iMessage runs through Photon cloud lines. Never install
  @spectrum-ts/imessage-local.
- All scripts must work in PowerShell and Git Bash (use cross-env, tsx, rimraf, node:path).

## Non-negotiables
- No UI, web pages, or mini apps. iMessage conversation only.
- Safety invariants I1 to I16 (spec Section 3) must hold. Changes to dialogue, plan engine,
  location, or notifications need a test proving the relevant invariant still holds.
- Never invent APIs. Verify Photon (Stable docs only: https://photon.codes/docs/llms.txt),
  LiveKit, and OpenAI against current docs or installed type definitions. Record verified
  signatures in docs/PHOTON_NOTES.md.
- The LLM never decides escalation. Code words are matched deterministically before any LLM call.
- Never read, print, or echo .env. Ask the human to add missing variables by name.
- Never use em dashes in copy, docs, or commit messages.

## Workflow
- Follow the phase plan (spec Section 14). Do not skip exit criteria.
- Delegate to subagents in .claude/agents for parallel, independent work. The main
  conversation owns decisions, integration, PROGRESS.md, and DECISIONS.md.
- After each phase: run the safety-reviewer subagent on the phase diff, fix findings, then
  run live checks (spec Section 16).
- Run `pnpm verify` before declaring any task done.
- When a test fails, fix the root cause. Never weaken a test unless the spec is wrong; if so,
  update the spec section and log why in DECISIONS.md.
- Small commits, one concern each, message names the spec section.
- When a step needs the human's iPhone, batch the requests, ask once, and wait.

## Commands
- pnpm install
- pnpm doctor               # toolchain + env presence + Photon auth check (never prints secrets)
- pnpm dev                  # run server with .env
- pnpm chat                 # talk to Batman in this console via the terminal provider
- pnpm verify               # typecheck, lint, unit, invariants, sim, evals
- pnpm test:sim             # replay scenarios with fake clock
- pnpm evals                # NLU eval suites, writes reports/evals/*
- pnpm e2e:probe            # live E2E over real iMessage using the probe line (spec 16.3)
- pnpm live:guide           # guided iPhone test session with the human (spec 16.4)
- pnpm spike <name>         # Phase 0 spikes
