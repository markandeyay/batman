# Safety invariants: where each one is tested

Spec Section 3 requires at least one automated test per invariant. Every invariant has a file in
this folder; the other files listed add depth (unit level, engine sims, full-stack sims).

`tests/sim/fullstack.test.ts` also checks I6, I10, and I14 after every full-stack scenario
(`checkGlobalInvariants`): no internal errors, every user message in a discreet state passes the
banned-word filter, nothing reaches an address after its STOP acknowledgement, and no message or
call goes to an emergency number.

| Invariant | In this folder | Also covered by |
|---|---|---|
| I1 Consent | `I01-consent.test.ts` | `tests/unit/core/stateMachine.test.ts` (6.2 DRAFT and arming), `tests/unit/conversation/templates.test.ts` (opt-in has no plan details), `tests/sim/fullstack.test.ts` (onboarding test, S-18) |
| I2 Only watch the initiator | `I02-only-initiator.test.ts` | `tests/unit/core/location.test.ts` (I2 / I3 helpers), `tests/sim/scenarios.test.ts` S-21, `tests/sim/fullstack.test.ts` S-21 |
| I3 Time-boxed | `I03-time-boxed.test.ts` | `tests/unit/core/stateMachine.test.ts` (I3 rows), `tests/sim/scenarios.test.ts` (I3) |
| I4 Minimal disclosure | `I04-minimal-disclosure.test.ts` | `tests/unit/core/stateMachine.test.ts` (where is she, I4) |
| I5 Ask the user first | `I05-ask-user-first.test.ts` | `tests/sim/scenarios.test.ts` S-03, S-08, S-17; `tests/sim/fullstack.test.ts` S-03 |
| I6 Never contact emergency services | `I06-no-emergency-services.test.ts` | `tests/sim/fullstack.test.ts` (global check) |
| I7 The LLM never decides to escalate | `I07-llm-never-escalates.test.ts` | `tests/unit/core/ladder.test.ts` (no NLU in the escalation path), `tests/unit/core/stateMachine.test.ts` (deterministic engine), `tests/sim/fullstack.test.ts` S-22 |
| I8 Code words are deterministic | `I08-codewords-deterministic.test.ts` | `tests/unit/conversation/codewords.test.ts`, `tests/unit/conversation/intakeManager.test.ts` (I8), `tests/evals/run.ts --codewords-only` (in `pnpm verify`), `tests/sim/fullstack.test.ts` S-14, S-15, S-16 |
| I9 Code word responses reveal nothing | `I09-codeword-responses.test.ts` | `tests/unit/core/stateMachine.test.ts` (alert word row), `tests/sim/fullstack.test.ts` S-12, S-13 |
| I10 Discretion | `I10-discretion.test.ts` | `tests/unit/conversation/discretion.test.ts`, `tests/sim/fullstack.test.ts` (global check and the I10 test) |
| I11 Honesty with the guardian | `I11-honesty.test.ts` | `tests/unit/conversation/templates.test.ts` (reason lines, no claimed call), `tests/sim/fullstack.test.ts` S-03, S-05, S-13, S-20 |
| I12 Deletion | `I12-deletion.test.ts` | `tests/unit/core/store.test.ts` (fixes and purge), `tests/unit/core/stateMachine.test.ts` (purge row), `tests/sim/scenarios.test.ts` (S-01 / I12), `tests/sim/fullstack.test.ts` S-01 |
| I13 Disclosure | `I13-I15-disclosure-adults.test.ts` | `tests/sim/fullstack.test.ts` (onboarding test) |
| I14 Stop means stop | `I14-stop.test.ts` | `tests/unit/core/stateMachine.test.ts` (STOP rows), `tests/sim/fullstack.test.ts` S-19, user STOP, global check |
| I15 Adults only | `I13-I15-disclosure-adults.test.ts` | |
| I16 Fail toward the user | `I16-fail-toward-user.test.ts` | `tests/sim/scenarios.test.ts` (I16, S-06 restart, S-25 host asleep), `tests/sim/fullstack.test.ts` S-22 |
