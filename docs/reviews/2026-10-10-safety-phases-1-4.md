# Safety review: phases 1 to 4 (2026-10-10)

Reviewer: safety-reviewer subagent (read-only). Scope: engine, scheduler, risk, store, dialogue, NLU, notify, code words, calls, speech, config, as merged on main before the gateway. Verdict at review time: not ready for a demo.

| Id | Severity | Invariant | Summary | Status |
|---|---|---|---|---|
| C1 | critical | I4, I11 | Engine send params do not match template params: guardian alerts lose location, reason, type, timezone | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| C2 | critical | I7 | OK, tapback, or "+30" stands down an alert-word or distress escalation | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| H1 | high | I7 | Model-only COMMAND done/home/cancel closes or cancels a live plan | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| H2 | high | I11 | gdn_all_clear says "home safe" for every close reason | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| H3 | high | I8, I5, I16 | Code words and distress ignored before T-30 | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| H4 | high | I16, I8 | plan_edited not handled; old timers stay after a time change | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| H5 | high | I5, I16 | Calls awaited serially; block guardian alert, L2 text, and the scheduler | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| M1 | medium | I3, I12 | ESCALATED never ends; watch and storage continue | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| M2 | medium | I16 | Crash between save and send loses gdn_alert (needs durable outbox) | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| M3 | medium | I16 | Persistent L3 failure spams error check-ins then fails silently | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| M4 | medium | I14, I1 | No durable stop list, dialogue state, or optin_sent_at | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| M5 | medium | 9.3 | Negation guard defeats "dont hurt me", "get off me" | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| M6 | medium | I10 | Discretion check runs on template id, not rendered text | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| M7 | medium | I14, I16 | "done" before window is a no-op; guardian stop mid-plan leaves no reachable guardian | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| L1 | low | log | Coordinates inside strings pass the logger at info | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| L2 | low | I2 | I2 filter skipped when fromAddress is undefined | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| L3 | low | I7 | Model-only NOT_OK escalates to L3 (spec 6.4 sanctioned tension) | logged in DECISIONS.md |
| L4 | low | copy | usr_guardian_stopped sent twice | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| L5 | low | ladder | Departure right after exit word fires a hard ladder | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| L6 | low | I11 | gdn_alert_repeat says "Still no reply" after an alert word | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |
| L7 | low | I1 | Tapback on any message arms a plan awaiting go | fixed (tests in tests/invariants/fix-*.test.ts, tests/unit/fixes/) |

Invariants found holding: I6 (no emergency contact by construction), I12 purge for closed plans, I13 and I15 disclosure, synchronous code word matching with innocuous replies (I8, I9 within windows), I1 plan-detail gating.

Executor requirements raised by the review are tracked in the fix task and gateway/executor.ts.
