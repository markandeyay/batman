# Batman: System Design Specification

**Version:** 2.0 (October 10, 2026)
**Target:** HackNC 2026, Photon track "Agents in iMessage"
**Builder:** Claude Code running on a **Windows** PC, using project subagents
**Doc status:** Authoritative. Where this spec and your assumptions disagree, the spec wins. Where this spec and the live Photon docs disagree, the live docs win, and you record the difference in `DECISIONS.md`.

---

## 0. How to use this document (read first, Claude Code)

1. This file lives at `docs/BATMAN_SPEC.md`. Before writing product code, create `CLAUDE.md`, `.claude/settings.json`, and `.claude/agents/*.md` exactly as given in Section 13.
2. Work in the phase order in Section 14. Do not start a phase until the previous phase's exit criteria pass.
3. **Never invent an API.** Every Photon, LiveKit, or OpenAI call must be checked against current docs or the installed package's type definitions before use. Photon docs: `https://photon.codes/docs/llms.txt` (use the **Stable** version; never mix Stable and Beta). If a method in this spec does not exist in the installed package, inspect `node_modules`, adapt, and log it in `DECISIONS.md`.
4. Phase 0 is a set of **spikes** that answer questions the docs do not. Several later design choices branch on spike results. Record results in `docs/SPIKES.md`.
5. Safety invariants in Section 3 are non-negotiable. A change that violates one fails review even if all tests pass.
6. **Never read, print, or paste the contents of `.env`.** Secrets are loaded by the app at runtime only (Section 13.2 denies Claude read access). If a value is missing, tell the human which variable to add.
7. Keep `PROGRESS.md` current (phase, what's done, what's next, blockers). A fresh Claude Code session must be able to resume from it alone.
8. Some steps need a human with an iPhone (accepting a Find My card, answering a call). Section 16.6 lists them. Batch them, ask once, and wait.
9. The definition of done is Section 18. The refinement loop in Section 16 runs until it is satisfied.

---

## 1. Product summary

### 1.1 One-liner
Batman is an iMessage contact that keeps you safe when you meet a stranger. Text it before a first date, a Facebook Marketplace meetup, or an apartment viewing. It asks a few smart questions, quietly watches your shared location for just that window, checks in only when something looks off, rings your phone if you go quiet, and alerts the friend you chose if you still don't answer. Two secret code words give you a silent way out: one makes your phone ring with a fake call, the other alerts your friend.

### 1.2 It is an iMessage integration, not an app, and it does not need a Mac
- There is **no app to install, no website, no dashboard, and no UI** for end users. The entire product is a conversation in Apple Messages with a contact the user saved on their iPhone.
- iMessage delivery is handled by **Photon's managed cloud lines**. Photon runs the Apple-side infrastructure, so the Batman server is ordinary Node.js that runs on Windows, Linux, or any cloud host. **No Mac is required** for development, testing, or production.
- The backend connects through the `spectrum-ts` SDK (persistent gRPC stream) and the lower-level `@photon-ai/advanced-imessage` SDK (needed for Find My location, Focus status, and Notify Anyway).
- Operators manage the system through CLI scripts and admin text commands sent from allowlisted phone numbers. No admin web UI.
- Do not build iMessage App Store extensions or mini-app cards. Plain iMessage features only (text, voice notes, tapbacks, threaded replies, typing indicators, Find My requests, calls).

### 1.3 Core loop
1. **Plan.** User texts "going on a date at 7 at Lula Cafe." Batman extracts what it can and asks at most a few follow-ups (duration, who, how they're getting there).
2. **Arm.** Batman confirms the plan in one message, the user replies "go."
3. **Share.** Before the meetup, Batman sends a native Find My request. The user shares location with Batman only.
4. **Watch quietly.** Batman detects arrival, stays silent while things look normal, and checks in only on triggers (leaving the venue unexpectedly, fast departure by car mid-meetup, location going dark, running past the planned end time).
5. **Escalate if needed.** Text → second text with Notify Anyway → ring the user's phone → alert the trusted contact by text and call.
6. **Exits.** Code word 1 → fake incoming call within ~20 seconds. Code word 2 → silent alert to the trusted contact.
7. **Close.** User texts "home" or arrives home. Trusted contact optionally gets "safe." Location data is deleted.

### 1.4 Non-goals (do not build)
- Calling 911 or any emergency service. Batman never contacts emergency services itself. It tells the trusted contact to call 911 if they believe there is danger.
- Background checks, identity verification, or scraping profiles.
- Continuous tracking outside a plan window. No "always-on" mode.
- Group chats. Batman works in 1:1 DMs only.
- Any visual UI, web page, or mini app.

### 1.5 Naming note
"Batman" is a hackathon codename. It is a DC Comics trademark, so rename before any public launch. Never use DC logos, artwork, or character imagery anywhere (including the contact card avatar). Use neutral names for test tooling (the test line is "probe," not another DC character).

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **User** | The person meeting a stranger. The only person Batman ever watches. |
| **Guardian** | The trusted contact the user chose. Must opt in by replying YES. |
| **Counterpart** | The stranger the user is meeting (date, buyer, seller, landlord). Batman never contacts them. |
| **Plan** | One meetup: type, time, place, expected duration, guardian, code words. |
| **Window** | From plan start minus 30 min until plan close. Location is used only inside a window. |
| **Check-in** | A discreet message asking the user if they're okay. |
| **Ladder** | The escalation sequence (Section 6.4). |
| **Exit word** | Code word that triggers a fake call. |
| **Alert word** | Code word that silently alerts the guardian. |
| **Fix** | One location snapshot (lat, lng, accuracy, timestamp, locationType). |
| **Line** | A Photon-provisioned iMessage phone number that Batman sends from. |
| **Probe** | A second Photon project/line used only by automated tests to act as a user or guardian over real iMessage (Section 16.3). |

---

## 3. Safety and privacy invariants (non-negotiable)

Every invariant gets at least one automated test (`tests/invariants/*`).

- **I1. Consent.** A guardian receives no plan details until they reply YES to the opt-in. A user must reply "go" (or equivalent) before a plan is armed. Location is only read after the user accepts the Find My request.
- **I2. Only watch the initiator.** Batman never requests, reads, or stores the location of anyone except the user who created the active plan. When reading locations, filter strictly by the user's exact address (Photon's `list()` may return other friends visible to the line).
- **I3. Time-boxed.** Location is only processed while a plan is in a window. Fixes received outside a window are discarded, not stored.
- **I4. Minimal disclosure.** The guardian sees location only during an escalation, and only the user's location. Coordinates are never sent to anyone else.
- **I5. Ask the user first.** Except for the alert word and explicit distress, Batman always contacts the user before contacting the guardian.
- **I6. Never contact emergency services.** No 911 calls, no texts to emergency numbers. Alert copy tells the guardian to call 911 if they believe there's danger.
- **I7. The LLM never decides to escalate.** Escalation is decided by the deterministic plan engine and risk rules (Sections 6 and 7). The LLM extracts structure from text and writes non-critical copy only.
- **I8. Code words are detected deterministically**, before any LLM call, on every inbound text and every voice-note transcript. A code word is never missed because a model call failed or timed out.
- **I9. Code word responses never reveal anything.** After an exit or alert word, Batman replies with an innocuous, friend-like message (or nothing) and never mentions safety, alerts, or the guardian.
- **I10. Discretion.** During an active window, every message Batman sends to the user must read like a text from a friend on a lock screen. No words like "safety," "alert," "emergency," "danger," "Batman," or "check-in" in user-facing copy during ACTIVE, OVERTIME, or CHECKING states.
- **I11. Honesty with the guardian.** Guardian alerts state what Batman knows and doesn't know ("hasn't replied for 6 min," "location last updated 4 min ago") and never claim certainty of danger.
- **I12. Deletion.** Raw location fixes are deleted 24 hours after a plan closes. Plan audit events keep only coarse data (no coordinates) after that.
- **I13. Disclosure.** At onboarding, Batman says it is an automated assistant, not a person, not an emergency service, and that it can fail (dead phone, no signal, Photon outage, host computer asleep).
- **I14. Stop means stop.** "STOP" from anyone (user or guardian) immediately stops all messages to that person. The user can end any plan at any time with "cancel" or "done."
- **I15. Adults only.** Onboarding states Batman is for people 18 and over. Do not store age.
- **I16. Fail toward the user.** If an internal error happens during an active plan, Batman sends the user a plain check-in rather than silently failing, and logs the error. If the scheduler or Photon stream is down at a scheduled escalation time, the escalation runs as soon as the service recovers (timers are durable).

---

## 4. Conversation design

### 4.1 Voice and style
- Short. Most messages are one or two lines. Never more than 4 lines except the plan confirmation and guardian alerts.
- Warm, casual, competent. Like a sharp friend, not a corporate bot.
- Plain text only. No markdown formatting, no bullet characters, no tables, no em dashes. Emoji: at most one per message, never in guardian alerts except the leading warning sign.
- Never lecture. At most 2 safety tips per plan, each one sentence.
- Mirror the user: if they send a voice note, Batman may reply with a voice note for plan confirmation and check-ins (configurable; default text).
- Acknowledge simple confirmations with a tapback (👍 via `Emoji.like`) instead of a new message when nothing else needs saying.
- Use typing indicators (`space.responding(...)`) whenever Batman will take more than ~1 second to reply.

### 4.2 Onboarding (first message from a new user)

Trigger: inbound message from an address with no `users` row.

```
Batman: Hey, I'm Batman. Text me before you meet someone new (a date, a Marketplace
        pickup, an apartment viewing) and I'll quietly look out for you.
Batman: Quick setup, takes a minute. What should I call you?
User:   Alex
Batman: Nice to meet you, Alex. Who should I contact if you might need help?
        Send me their name and number, or share their contact card.
User:   [shares contact card: Priya, +1 919 555 0142]
Batman: Got it. I'll text Priya to ask if she's okay being your backup. She'll only
        hear from me if you might need help.
Batman: Now pick two secret code words. Text one of them to me anytime during a meetup:
        1) an EXIT word: your phone rings with a "call" so you have an excuse to leave
        2) an ALERT word: I quietly text Priya your location
        Pick words you'd never text by accident. Send them like: exit pineapple, alert blue moon
User:   exit pineapple alert blue moon
Batman: Locked in. Last thing: save me as a contact under any name. Most people pick
        something boring like "Mom" so my texts look normal on your lock screen.
        I'll call from this same number when you use your exit word.
Batman: [shares its own native contact card]
Batman: Heads up: I'm an automated assistant, not a person and not 911. I can't help
        if your phone is dead or has no signal. You must be 18+ to use me.
        You're all set. Text me before your next meetup.
```

Rules:
- Name: required. Store as display name only.
- Guardian: required before any plan can be armed. Accept a shared contact card (`contact` content), or a name plus number in text. Normalize to E.164 (default region US; ask if ambiguous). Reject the user's own number.
- Before texting the guardian, check `im.addresses.isIMessageAvailable(guardian)`. If false, still proceed (Photon has SMS/RCS fallback) but tell the user "Priya might get my texts as green bubbles."
- Code words: each must be 1 to 3 words, at least 5 letters total, not a common reply word (deny list: ok, okay, yes, no, yeah, yep, nope, good, fine, great, done, home, help, stop, cancel, here, sure, thanks, lol, haha), not equal to each other, and not within edit distance 2 of each other. If invalid, explain in one line and ask again.
- Contact card sharing uses Photon's native contact card sharing feature (cloud provider only).
- Onboarding can be resumed; persist step progress.
- Decoy caller choice (for the fake call voice): ask only if the user brings it up; default "roommate." Command "change caller" lets them pick mom, roommate, or boss.

### 4.3 Guardian opt-in

```
Batman → Priya: Hi Priya, Alex added you as their backup on Batman, an automated
                assistant that looks out for people meeting strangers. You'd only hear
                from me if Alex might need help. Reply YES to accept or NO to decline.
Priya:          yes
Batman → Priya: Thanks. If I ever text you about Alex, it means they haven't answered
                me. Reply STOP anytime to stop these messages.
Batman → Alex:  Priya's in. 👍
```

- Opt-in expires after 48 hours. If no reply, tell the user and ask for another guardian.
- NO or STOP: tell the user "Priya declined, want to add someone else?"
- A guardian can be the guardian for multiple users. Each user-guardian link has its own consent record.
- A user may plan before the guardian accepts, but arming requires an accepted guardian. If the meetup is soon and the guardian hasn't accepted, say so plainly and offer to arm with a different guardian.

### 4.4 Planning a meetup (intake)

#### 4.4.1 Supported meetup types

| Type | Examples | Default duration | Special concerns |
|---|---|---|---|
| `date` | first date, Hinge/Tinder/Bumble meetup | 2 h | venue changes are common and usually fine |
| `marketplace` | FB Marketplace, Craigslist, OfferUp buy or sell | 20 min | private addresses, cash, being followed, fast departures |
| `viewing` | apartment/rental viewing, sublet tour | 45 min | indoor GPS drift, deposit scams, private building |
| `other` | meeting someone new for any other reason | 1 h | generic rules |

#### 4.4.2 Fields

| Field | Required to arm | How to get it | Default if not given |
|---|---|---|---|
| `type` | yes | infer from text; ask only if unclear | none |
| `startAt` | yes | parse ("at 7", "tonight 8:30", "in an hour"); confirm explicitly | none |
| `venueText` | yes | text, or a dropped location pin | none |
| `venueGeo` | no (strongly preferred) | geocode `venueText`; if ambiguous, ask for a pin | null (time-only watching) |
| `durationMin` | yes | ask "How long do you think it'll take?" | type default, stated to the user |
| `counterpartName` | no | ask once | "the person you're meeting" |
| `counterpartSource` | no | which app or site | null |
| `transport` | no | "How are you getting there and back?" (`self_drive`, `rideshare`, `transit`, `walk`, `their_car`) | null |
| `firstTimeInPerson` | dates only | ask | true |
| `buyOrSell` | marketplace only | infer or ask | null |
| `meetingAtPrivateAddress` | marketplace/viewing | infer from geocoder place type or ask | null |
| `notifyGuardianOnStartEnd` | no | ask only if user mentions it | false |

#### 4.4.3 Question policy (keeps it smart and short)
- Extract everything possible from the first message (LLM extractor, Section 9.2).
- Then send **at most one follow-up message containing at most 3 questions**, ordered by importance: start time → venue → duration → counterpart name → transport. Type-specific questions replace the lowest-priority generic ones.
- State defaults instead of asking when a sensible default exists: "I'll assume about 2 hours, tell me if it's longer."
- Never ask for something the user already said. Never re-ask a declined optional question.
- If the user answers only some questions, ask again only for missing **required** fields, once more. After that, arm with defaults and say which defaults were used.

#### 4.4.4 Type-specific follow-ups (bank)

**Date**
- "First time meeting in person?"
- "What's their name, and where'd you meet?"
- "How are you getting there and back?" (If `their_car`: one gentle tip: "Maybe keep your own ride home as an option.")
- Tip pool: "Keep your drink with you." / "Meet in public the first time." (pick at most one, only if relevant)

**Marketplace**
- "Buying or selling? What's the item?"
- If the venue looks like a residence (geocoder place type is address/house, or user said "their place," "my place," "my apartment"): "Want to move it to a public spot? A lot of police stations have safe exchange zones." Do not refuse; if the user keeps the residence, raise vigilance (Section 7.4).
- If price is large or cash: "If it's cash, count it somewhere visible."
- Default duration 20 min; ask "Should take about 20 min?"

**Viewing**
- "Is a landlord or agent meeting you there?"
- "Have you paid anything yet?" If yes and before viewing: one line: "Heads up, asking for deposits before a viewing is a common scam."
- Default duration 45 min.

**Other**
- "Who are you meeting, and roughly how long?"

#### 4.4.5 Time handling
- Store all times in UTC; render in the user's timezone.
- Timezone source, in order: explicit user statement → first location fix (timezone lookup from coordinates via a library such as `geo-tz`) → `DEFAULT_TZ` env (America/New_York).
- Always confirm parsed times with day and clock time: "Sat 7:00 PM." If the parsed start time is in the past, ask: "Did you mean 7 PM tomorrow?"
- Plans more than 7 days out are allowed but Batman re-confirms the day before.

#### 4.4.6 Plan confirmation (arming)

```
Batman: Here's the plan:
        Date with Jordan (Hinge), Sat 7:00 PM at Lula Cafe, 2537 N Kedzie
        Back by about 9:00 PM. You're driving yourself.
        If something seems off I'll text you, then call you, then text Priya.
        Reply GO to lock it in, or tell me what to change.
User:   go
Batman: [👍 tapback]
Batman: Locked in. Around 6:30 I'll ask you to share your location until it's over.
```

- Edits after arming are allowed: "actually 8pm," "we're moving to the bar next door." Re-confirm only changed fields.
- One active or armed plan per user at a time. If a second plan is requested while one is armed, ask whether to replace it.

### 4.5 Pre-meetup (T minus 30 min, or immediately if start is sooner)

1. If the user's location is already visible to Batman's line with `expiresAt` after the planned end (+60 min), skip the request.
2. Otherwise send the Find My request via `im.locations.request(chatGuid, userAddress, { clientMessageId: "loc-" + planId })`, preceded by:
   ```
   Batman: Tap Share on the card below and pick "Share Until End of Day."
           I'll stop looking when you're done.
   ```
3. Poll `im.locations.get(userAddress)` every 30 s for up to 15 min to detect acceptance. On acceptance: 👍 tapback on the user's latest message, and start the watcher.
4. If not accepted within 15 min or by start time: one reminder. If still not shared at start: switch the plan to **time-only mode** (check-ins and overtime still work, location-based triggers are off) and tell the user once: "No location, no problem. I'll just check in on time."
5. If the share's `expiresAt` is before planned end + 60 min, ask once to extend the share.

### 4.6 Active meetup

- **Arrival** (Section 7.2): when the user is inside the venue geofence for 2 consecutive fixes, or at start time in time-only mode, send one discreet line: "Have fun! Text me when you head out." During ACTIVE, that is the only proactive message unless a trigger fires.
- **Mid-meetup check (dates only, optional):** if `firstTimeInPerson` and duration ≥ 90 min, at 45% of the window send "How's it going?" Any reply that is not a code word or a negative counts as OK; react 👍 and say nothing else.
- **User-initiated commands** (any time in the window):

| User says (examples) | Action |
|---|---|
| "done," "leaving," "heading home," "all good im out" | → CLOSING: if a home geofence exists, watch for arrival home for up to 90 min; otherwise close now. |
| "home," "made it home," "im home" | → CLOSED. |
| "+30," "add 30 min," "going to be longer," "we're getting dinner after" | extend planned end, confirm new end time in one line. |
| "we're moving to [place]" | update venue; geocode; one-line confirm. |
| "cancel," "not going," "he cancelled" | → CANCELLED; confirm. |
| exit word | Section 6.6. |
| alert word | Section 6.7. |
| "help," "I don't feel safe," "come get me," "he won't let me leave" | treat as **explicit distress** → jump straight to ladder step L3 (guardian alert) and also place the exit call: reply "Calling you now." |

### 4.7 Overtime
At planned end + grace (5 min for marketplace/viewing, 15 min for date/other), if the plan isn't closed:
```
Batman: Still out? Reply +30 if you're staying, or "home" when you're back.
```
- Reply with +N or any OK-like reply: extend (default +30 min) and confirm the new time.
- No reply within the check window: enter the ladder at L1 (Section 6.4).
- Maximum total extensions without explicit user time: 4 hours, after which Batman asks the user to confirm they're okay and closes the plan on reply.

### 4.8 Closure
```
User:   home
Batman: Glad you're back. 👍 Plan closed and your location's no longer shared with me.
        (You can stop sharing in Find My too.)
Batman → Priya (only if notifyGuardianOnStartEnd or an escalation reached the guardian):
        Alex is home safe. Thanks for being their backup.
```

### 4.9 Help and status commands
- "help" outside a window: short capability summary.
- "status": current plan summary in one message.
- "change backup," "change code words," "change caller," "delete my data": supported flows. "delete my data" deletes the user, their plans, fixes, and consent records after a confirmation, and texts the guardian nothing.

---

## 5. Guardian experience

### 5.1 Alert message (L3), fixed template, no LLM

```
⚠️ Alex might need help.
Alex hasn't answered my last 3 messages or a call (6 min) during a date with Jordan (Hinge).
Last location at 7:42 PM (2 min ago, ±20 m): 1820 N Milwaukee Ave, Chicago
https://maps.apple.com/?ll=41.9139,-87.6800&q=Alex
Plan: Lula Cafe, 7:00 to 9:00 PM. Alex is driving themselves.
Please call Alex now. If you think they're in danger, call 911.
Reply GOT IT so I know you're on it.
```

Variants: the trigger reason line changes per trigger ("left the meetup by car and hasn't replied," "location stopped updating and they haven't replied"). For the alert word: "Alex sent me their private alert word. That means they want help but may not be able to talk." For explicit distress: quote nothing; say "Alex texted me that they don't feel safe."

### 5.2 Alert call
Immediately after the alert text, Batman calls the guardian (Section 10) and plays a short synthesized message, repeated twice:
"This is Batman, an automated safety assistant for Alex. Alex hasn't responded during a meetup. I've texted you their last location. Please call Alex now, and call 911 if you think they're in danger."
If the call fails, continue by text only.

### 5.3 Ongoing updates
- While escalated and the guardian hasn't replied GOT IT: resend a shortened alert every 3 min, up to 5 times, using `notifySilenced` if Focus is on.
- After GOT IT: send location updates only when the location changes by more than 150 m or every 5 min, whichever is later, until resolved or 2 hours pass.
- When the user replies OK during escalation: Batman confirms with the user ("Got it, glad you're okay. I'd let Priya know too.") and tells the guardian "Update: Alex just replied that they're okay." Location updates to the guardian stop immediately.

### 5.4 Guardian commands
| Guardian says | Action |
|---|---|
| GOT IT / ok / on it | mark acknowledged, reduce cadence |
| "where is she," "location" | send latest fix (only during an active escalation; otherwise "I only share location during an alert.") |
| "call her" | Batman places a check-in call to the user (Section 10.3) |
| STOP | stop all messages to guardian; tell the user their backup opted out |

---

## 6. Plan engine (deterministic state machine)

### 6.1 States

| State | Meaning |
|---|---|
| `DRAFT` | Intake in progress |
| `AWAITING_GUARDIAN` | Plan complete but guardian hasn't accepted |
| `ARMED` | Confirmed; before T-30 |
| `PRE_MEETUP` | T-30 to start; requesting location |
| `ACTIVE` | Inside the meetup window |
| `OVERTIME` | Past planned end + grace, waiting for reply |
| `CHECKING` | A trigger fired; ladder L0 to L2 in progress |
| `ESCALATED` | Guardian alerted (L3) |
| `CLOSING` | User left; waiting for home arrival (optional) |
| `CLOSED` | Ended normally |
| `CANCELLED` | User cancelled |
| `EXPIRED` | Never armed (draft older than 12 h) or never started |

### 6.2 Transitions

| From | Event | To | Side effects |
|---|---|---|---|
| DRAFT | all required fields + guardian accepted + user "go" | ARMED | schedule T-30 timer |
| DRAFT | required fields + "go" but guardian not accepted | AWAITING_GUARDIAN | tell user |
| AWAITING_GUARDIAN | guardian YES | ARMED | tell user "Priya's in, you're armed" |
| ARMED | T-30 timer | PRE_MEETUP | send Find My request |
| ARMED/PRE_MEETUP | startAt timer | ACTIVE | start watchers, schedule end timer |
| ACTIVE | arrival detected | ACTIVE | send arrival line (once) |
| ACTIVE | end + grace timer | OVERTIME | send overtime message, schedule reply timeout |
| ACTIVE/OVERTIME | risk trigger (Section 7) | CHECKING (L0) | send L0 check |
| CHECKING | user OK reply | ACTIVE (or OVERTIME if past end) | 👍 tapback, clear ladder |
| CHECKING | ladder timeout after L2 | ESCALATED | guardian alert text + call |
| any active | alert word | ESCALATED | silent alert (Section 6.7) |
| any active | explicit distress | ESCALATED | alert + exit call to user |
| any active | exit word | same state | fake call (Section 6.6); start a 10 min post-exit watch |
| ACTIVE/OVERTIME/CHECKING | "done" | CLOSING or CLOSED | |
| ESCALATED | user OK reply | ACTIVE or CLOSED | notify guardian "replied okay" |
| CLOSING | home arrival or "home" or 90 min | CLOSED | guardian all-clear if needed |
| any non-terminal | "cancel" | CANCELLED | |
| CLOSED/CANCELLED | +24 h timer | (same) | purge fixes (I12) |

### 6.3 Durable timers
- All timers are rows in a `jobs` table (`runAt`, `kind`, `planId`, `payload`, `status`, `attempts`). A scheduler loop polls every 2 s (scaled by `TIME_SCALE`) and claims due jobs inside a transaction.
- `setTimeout` may be used only as a wake-up optimization, never as the source of truth.
- On boot, the scheduler runs overdue jobs immediately (I16). Jobs are idempotent: each job checks the plan's current state and ladder step before acting.
- A `Clock` interface (`now()`, `sleep()`) is injected everywhere. Production uses real time; tests use a fake clock; demo mode uses `TIME_SCALE` (e.g., 60 means one real second equals one simulated minute).
- Windows note: when the PC sleeps, nothing runs. Durable timers make the system catch up on wake, but that is too late for safety. Section 17 covers keeping the host awake or deploying to an always-on host.

### 6.4 Escalation ladder

| Step | When | Action to user | Action to guardian |
|---|---|---|---|
| **L0** | trigger fires | discreet text: "Hey, everything good?" (variants per trigger, Section 7.6) | none |
| **L1** | no reply in `T1` | second text: "Text me back when you can 🙂" + `notifySilenced` if Focus on | none |
| **L2** | no reply in `T2` | **ring the user's phone** (check-in call, Section 10.3) | none |
| **L3** | no reply in `T3` after L2, or call declined/unanswered with no text | no further user messages except one discreet line when they reply later | alert text + alert call + updates |

Default timings (minutes). Night hours (22:00 to 05:00 local) multiply by 0.7. High-vigilance plans (Section 7.4) multiply by 0.6.

| Trigger class | T1 | T2 | T3 |
|---|---|---|---|
| Overtime | 10 | 5 | 3 |
| Soft anomaly (left venue on foot, venue change unanswered) | 5 | 4 | 3 |
| Hard anomaly (fast vehicle departure mid-meetup, location dark, far away) | 3 | 2 | 2 |
| Guardian-requested check ("call her") | n/a | immediate | 3 |

A user reply at any step resolves the ladder unless it is classified `NOT_OK` (Section 9.3), in which case jump to L3 and offer the exit call.

### 6.5 Reply classification during CHECKING
Order of evaluation (first match wins):
1. Alert word (deterministic) → L3 silent.
2. Exit word (deterministic) → fake call; ladder pauses for the 10 min post-exit watch.
3. Explicit distress keywords (deterministic list plus classifier) → L3 + exit call.
4. Classifier (Section 9.3): `OK` → resolve; `NOT_OK` → L3; `AMBIGUOUS` → treat as not yet confirmed: send one clarifying line "All good? Just reply yes or no 🙂" and keep the current step's timer running (do not restart it).
5. Any tapback reaction from the user on Batman's last message counts as `OK` (👍, ❤️, 😂, ‼️). A 👎 or ❓ counts as `AMBIGUOUS`.

### 6.6 Exit word flow
1. Detect (Section 9.1). Within 2 s, reply with an innocuous line chosen randomly from: "lol ok", "haha true", "omg ok one sec". Never mention a call.
2. Place the fake call to the user within 20 s (Section 10.2). Caller ID is Batman's line, which the user saved as their decoy name.
3. If the call can't be placed (voice not configured, SIP error), fall back within 5 s: send a TTS voice note in the decoy caller's voice saying "Hey, I need you to call me back right now, it's kind of urgent" and a text "Call me asap". Log the fallback.
4. Start a 10-minute post-exit watch: if the user's location hasn't left the venue geofence after 10 min, send L0 ("Did you get out okay?").

### 6.7 Alert word flow
1. Detect. Reply with an innocuous line or nothing (configurable, default "haha ok").
2. Jump to ESCALATED: guardian alert text and call immediately.
3. Do **not** message the user about the alert. Continue silent watching and guardian updates.
4. The user can de-escalate by texting "home" or "I'm okay now"; Batman tells the guardian "Alex says they're okay now."

---

## 7. Location and risk engine

### 7.1 Location sources (in priority order)

| Source | How | When used |
|---|---|---|
| `findmy` | `@photon-ai/advanced-imessage` `im.locations.watch(userAddress)` stream plus `im.locations.get(userAddress)` heartbeat every 60 s | default if Spike S1 passes |
| `pin` | user sends "Send My Current Location" pin in iMessage; parse coordinates (Spike S4) | fallback, and to set venue/home |
| `replay` | JSON track files for tests and demos | tests, demo mode, probe E2E |
| `none` | time-only mode | no sharing |

Implement a `LocationSource` interface: `start(userAddress)`, `stop()`, emits `Fix { lat, lng, accuracyM, at, locationType, expiresAt }`. The risk engine consumes fixes from any source the same way.

Photon facts that drive the design (from Stable docs):
- `request(...)` only sends the card. It does not mean the user is sharing. Detect acceptance with `get()` (throws `NotFoundError` when not visible).
- `list()`, `get()`, and `watch()` only return shares visible to the line's account. `latitude`/`longitude` can be absent; always check both.
- `locationType` is `live`, `shallow`, `legacy`, or `unknown`. It describes freshness only.
- `watch()` is a live stream; updates missed during a disconnect are **not replayed**. So: reconnect with backoff (1, 2, 4, 8, max 30 s), dedupe on `sourceSequence`, and always run the `get()` heartbeat so a dropped stream is detected within 60 s.
- Phone numbers must be E.164.

### 7.2 Geometry and fix quality
- Distance: haversine in meters.
- **Usable fix:** has coordinates, `accuracyM ≤ 200`, `at` within 10 min of now. Others are stored for debugging but ignored for decisions.
- **Venue geofence radius:** `max(base, 2 × accuracyM)` where `base` is 120 m (date/other), 150 m (marketplace), 250 m (viewing, indoor drift).
- **Inside:** distance ≤ radius. **Outside:** distance > radius × 1.5 (hysteresis prevents flapping).
- **Arrival:** 2 consecutive usable fixes inside, at least 45 s apart.
- **Departure:** 2 consecutive usable fixes outside, at least 60 s apart.
- **Speed:** distance / time between consecutive usable fixes ≥ 60 s apart. **Vehicle speed:** ≥ 7 m/s (≈ 25 km/h) on 2 consecutive segments.
- **Dark:** no usable fix for 10 min while the share is expected to be live (`expiresAt` in the future) during ACTIVE/OVERTIME/CHECKING.
- **Home geofence (optional):** set when the user drops a pin and says "this is home," radius 150 m. Stored coarsely (rounded to 3 decimals) only while the user exists.

### 7.3 Triggers (rules, not ML)

| ID | Condition | Class | Applies to |
|---|---|---|---|
| T-OVR | now > planned end + grace and not closed | Overtime | all |
| T-DEP-WALK | departure during ACTIVE before planned end − 10 min, not vehicle speed, user hasn't said done | Soft | all |
| T-DEP-CAR | departure at vehicle speed during ACTIVE before planned end − 10 min | Hard | all; no trigger if within 10 min of a user "done" text |
| T-DEP-CAR-THEIRS | departure at vehicle speed and `transport ∈ {walk, transit, rideshare}` | Hard | all (user wasn't expected to be in a car yet) |
| T-FAR | distance from venue > 5 km during ACTIVE, user hasn't said "moving to" | Hard | all |
| T-DARK | dark condition | Hard | all |
| T-NOARRIVE | start + 20 min and no arrival detected, location live | Soft | all |
| T-MKT-LONG | marketplace still ACTIVE at 2× planned duration | Soft | marketplace |
| T-VENUE-CHG | user moved and stayed > 10 min at a new place within 2 km during a date | Info: one discreet line "New spot? 🙂". Becomes Soft if unanswered for 15 min | date |
| T-POST-EXIT | 10 min after exit word, still inside venue geofence | Soft | all |

Suppression rules:
- At most one active ladder per plan. New triggers during a ladder upgrade the class (Soft → Hard shortens remaining timers) but never restart it.
- After a user OK, the same trigger ID is suppressed for 20 min.
- No location triggers in time-only mode.
- Triggers never fire in DRAFT, ARMED, PRE_MEETUP (except T-NOARRIVE, evaluated from start), CLOSED, CANCELLED, or EXPIRED.

### 7.4 High-vigilance plans
Multiply ladder timers by 0.6 when any of these hold: marketplace at a private address, viewing where the user said nobody else will be there, the counterpart is driving the user, the user said "I'm nervous" or similar during intake, night hours. Tell the user nothing about vigilance levels.

### 7.5 Accuracy targets (measured in Section 15)
- **Code word detection:** 100% recall on the test set (exact, case, punctuation, and 1-typo variants for words of 5+ letters), < 0.5% false positives on a 2,000-message benign corpus.
- **Reply classifier:** ≥ 98% accuracy on a labeled set of ≥ 300 replies; **zero** `NOT_OK` or distress messages classified as `OK`.
- **Replay scenarios:** every scenario in Section 15.3 produces exactly the expected ladder outcome; zero guardian alerts in the "normal" scenarios.
- **Arrival/departure:** detected within 3 fixes of the true transition in replay tracks with realistic noise (±30 m Gaussian, occasional 300 m outliers).

### 7.6 L0 copy variants (discreet, rotate randomly)
- Overtime: "Still out? Reply +30 if you're staying, or 'home' when you're back."
- Soft: "Hey, everything good?" / "How's it going? 🙂"
- Hard: "Hey, text me back when you see this" / "You good?"
- T-NOARRIVE: "Did you make it there?"
- T-POST-EXIT: "Did you get out okay?"

---

## 8. Architecture

### 8.1 Runtime choices (Windows-first, cross-platform)
- **Language/runtime:** TypeScript on the current Node.js LTS (24.x; 22.x also works). `spectrum-ts` supports Node or Bun; use Node because LiveKit's real-time SDK ships native Node bindings.
- **Package manager:** pnpm workspace (enable with `corepack enable`).
- **Database:** SQLite via `better-sqlite3` (has Windows x64 prebuilt binaries) with Drizzle ORM. Single file, WAL mode.
- **Validation:** zod for every external input (LLM outputs, Photon payloads, env).
- **Tests:** vitest.
- **Logging:** pino, JSON logs to stdout and `logs/batman.log`. Redact phone numbers to the last 4 digits and drop coordinates at info level.
- **Process model:** exactly **one** running instance (the Spectrum message stream and location watch are long-lived connections; two instances would double-reply). Enforce with a lock row in SQLite on boot.
- **Cross-platform rules (Windows):**
  - Use `node:path` everywhere; never hardcode `/` or `\` separators. Never shell out with bash-only syntax from app code.
  - npm scripts must work in PowerShell and Git Bash: use `cross-env` for env vars in scripts, `tsx` to run TypeScript, `rimraf` instead of `rm -rf`.
  - Handle shutdown on `SIGINT` and `SIGBREAK` (Windows Ctrl+Break) in addition to `SIGTERM`; call `app.stop()`.
  - Add `.gitattributes` with `* text=auto eol=lf` so tests comparing text don't break on CRLF.
  - ffmpeg is required for audio conversion; install with `winget install Gyan.FFmpeg` and resolve its path via `FFMPEG_PATH` env or PATH. Alternatively use the `ffmpeg-static` npm package.
  - If a native module fails to install on Windows (rare), the fallback is to run the project inside WSL 2 Ubuntu; nothing in the design depends on Windows-specific behavior.

### 8.2 Components

```
                   ┌─────────────────────────── batman (single Node process) ───────────────────────────┐
 iMessage users ⇄  │  Gateway (spectrum-ts cloud provider: app.messages stream, send, react, responding)│
 (Photon cloud     │      │   + terminal provider in dev (chat with Batman in a console window)          │
  lines)           │      ▼                                                                              │
                   │  Inbound pipeline: dedupe → code words (deterministic) → transcribe voice notes →  │
                   │                    intent/extract (LLM, zod-validated) → Dialogue manager          │
                   │      │                                                                              │
                   │      ▼                                                                              │
                   │  Plan engine (state machine) ⇄ Scheduler (durable jobs) ⇄ Risk engine               │
                   │      │                               ▲                                              │
                   │      │                               │ fixes                                        │
                   │      │                     Location service (advanced-imessage locations / pin /    │
                   │      │                                       replay / none)                         │
                   │      ▼                                                                              │
                   │  Notifier (fixed templates + LLM copy for intake only)                               │
                   │  Call service (LiveKit Cloud SIP → Photon Spectrum Voice) + Speech (STT/TTS)         │
                   │  Geocoder, Timezone, Store (SQLite), Audit log, Admin commands, Test control port    │
                   └──────────────────────────────────────────────────────────────────────────────────────┘
```

All network traffic from the Windows host is **outbound** (gRPC to Photon, HTTPS to OpenAI/LiveKit/geocoder). Call audio (RTP) flows between the carrier and LiveKit Cloud, never to the PC. So no port forwarding, firewall rules, or public URL are needed.

### 8.3 Repository layout

```
batman/
  CLAUDE.md
  PROGRESS.md
  DECISIONS.md
  .gitattributes
  .env.example
  docs/
    BATMAN_SPEC.md          (this file)
    SPIKES.md               (Phase 0 results)
    PHOTON_NOTES.md         (verified API notes with doc links)
  .claude/
    settings.json
    agents/*.md
  apps/
    server/                 (the Batman service)
      src/
        index.ts            (boot: env, db, lock, spectrum, scheduler, watchers)
        config/env.ts
        gateway/spectrum.ts (Spectrum init, inbound loop, send helpers)
        gateway/imessageAdvanced.ts (advanced-imessage client factory + token refresh)
        gateway/terminal.ts (dev-only terminal provider wiring)
        pipeline/inbound.ts
        pipeline/codewords.ts
        pipeline/transcribe.ts
        nlu/extractPlan.ts
        nlu/classifyReply.ts
        nlu/prompts/*.md
        dialogue/manager.ts
        dialogue/onboarding.ts
        dialogue/intake.ts
        dialogue/guardian.ts
        plan/stateMachine.ts
        plan/ladder.ts
        scheduler/jobs.ts
        location/source.ts
        location/findmy.ts
        location/pin.ts
        location/replay.ts
        risk/geometry.ts
        risk/triggers.ts
        calls/livekit.ts
        calls/scripts.ts
        speech/stt.ts
        speech/tts.ts
        geo/geocode.ts
        geo/timezone.ts
        notify/templates.ts
        notify/copy.ts
        store/schema.ts
        store/repo.ts
        admin/commands.ts
        testing/controlPort.ts (127.0.0.1 only, enabled only when TEST_MODE=1)
        util/clock.ts
        util/phone.ts
    probe/                  (live E2E driver: a second Photon line acting as user/guardian)
  scripts/
    admin-add-user.ts
    spike-*.ts
    replay-scenario.ts
    live-guide.ts           (guided human-in-the-loop iPhone test runner)
    doctor.ts               (checks Node, pnpm, ffmpeg, env vars present, Photon auth)
  tests/
    unit/
    invariants/
    sim/                    (fake clock + replay scenarios)
    evals/                  (NLU datasets + runners)
    fixtures/tracks/*.json
  reports/                  (generated: eval, sim, and live reports)
  logs/
```

### 8.4 Inbound pipeline (exact order)

1. Receive `[space, message]` from `app.messages`.
2. Skip `message.direction === "outbound"`.
3. Handle `content.type === "read"` explicitly (store as delivery signal; never reply). Read receipts are high-volume; a default branch that replies would reply to every receipt.
4. Dedupe on `message.id` (store processed ids for 7 days).
5. Resolve sender address (narrow with `imessage(message)`; use `sender.address`). Look up user/guardian role. A number can be both a user and a guardian; route by context: an open guardian obligation (pending opt-in or active escalation for someone else) takes precedence for guardian keywords (YES, NO, GOT IT, STOP, "where").
6. Normalize content:
   - `text` → text.
   - `voice` → bytes via `read()` → STT → text (mark `fromVoice`). Timeout 15 s; on failure, reply "Couldn't hear that one, can you text it?" and, if a plan is in CHECKING, treat as AMBIGUOUS.
   - `contact` → guardian candidate (onboarding) or possible location pin (check `urls` for a maps link, Spike S4).
   - `attachment` → if it is a location vCard (`.loc.vcf` or `text/vcard` with a maps URL), parse coordinates; else ignore with a short reply.
   - `reaction` → if targeting Batman's latest check-in message, map per Section 6.5.
   - `poll_option` → unused.
7. Run **code word detection** (Section 9.1). If matched and a plan is in a window, execute the flow and stop.
8. Run deterministic keyword rules (STOP, HELP, distress list, +N extensions, "home," "done").
9. If not resolved, call the NLU extractor/classifier with the dialogue context.
10. Dialogue manager decides actions; plan engine applies transitions; notifier sends.
11. Write audit events for every state change and every outbound message.

### 8.5 Outbound sending rules
- Send via `space.send(...)`; for the guardian, resolve or create a DM space (`imessage(app).space.create(await imessage(app).user(guardianE164))`).
- Wrap slow paths in `space.responding(async () => ...)` for the typing indicator.
- Tapbacks via `message.react(Emoji.like)`.
- Voice notes via `voice(buffer, { name: "note.m4a", mimeType: "audio/mp4", duration })`.
- Keep the `Message` returned by each check-in send; its id is the target for reaction matching.
- On send failure: retry with backoff (3 attempts). For L3 guardian alerts: retry up to 10 times over 5 min, and log a critical error if still failing.
- Respect Photon quotas: 5,000 messages per server per day; 50 new conversations initiated per line per day. Track counters; if near the cap, prioritize safety messages and refuse new onboarding with a polite message.
- The dialogue layer depends on a small `Channel` interface (send text, send voice, react, typing, share contact), not on iMessage directly, so the terminal provider and tests can drive the exact same logic.

---

## 9. NLU and LLM usage

### 9.1 Code word detection (deterministic, no LLM)
- Normalize: Unicode NFKC, lowercase, strip punctuation and emoji, collapse whitespace.
- Match a code phrase if its normalized tokens appear as a contiguous token sequence anywhere in the message.
- Fuzzy: for code words with ≥ 5 letters, allow Damerau-Levenshtein distance ≤ 1 per token. Never fuzzy-match words shorter than 5 letters.
- Run on texts and on voice-note transcripts (also try a phonetic match via Double Metaphone for transcripts).
- If both words appear, the alert word wins.
- Unit-test with a generated suite: each code word × {exact, uppercase, trailing punctuation, embedded in sentence, one typo, autocorrect-style split} plus a 2,000-message benign corpus for false positives.

### 9.2 Plan extraction (LLM, structured output)
- Use the OpenAI API with a JSON schema (structured outputs). Model from env `LLM_MODEL_SMART`; check OpenAI's current docs for available model names. (If the human prefers Anthropic's API, implement an `LlmProvider` interface with both, selected by `LLM_PROVIDER`; schemas and validators stay identical.)
- Input: the user's latest message(s) in DRAFT, the current partial plan, now (ISO with timezone), and the user's timezone.
- Output schema (zod mirrors it):

```ts
const PlanExtraction = z.object({
  type: z.enum(["date", "marketplace", "viewing", "other"]).nullable(),
  startAtText: z.string().nullable(),         // verbatim time phrase
  startAtISO: z.string().nullable(),          // model's resolution; re-checked with chrono-node
  venueText: z.string().nullable(),
  durationMin: z.number().int().min(5).max(720).nullable(),
  counterpartName: z.string().max(60).nullable(),
  counterpartSource: z.string().max(40).nullable(),
  transport: z.enum(["self_drive","rideshare","transit","walk","their_car","unknown"]).nullable(),
  firstTimeInPerson: z.boolean().nullable(),
  buyOrSell: z.enum(["buy","sell"]).nullable(),
  meetingAtPrivateAddress: z.boolean().nullable(),
  userNervous: z.boolean(),
  wantsToChange: z.array(z.string()).max(5),  // field names the user is editing
  confidence: z.number().min(0).max(1)
});
```

- Time resolution: parse `startAtText` with `chrono-node` in the user's timezone. If chrono and the model disagree by more than 15 min, ask the user to confirm. Never arm with an unconfirmed time.
- The dialogue manager (code, not LLM) decides which questions to ask from the missing fields using Section 4.4.3. The LLM may phrase the question message from a list of question IDs (Section 9.4).

### 9.3 Reply classification (LLM + rules)
- Used only in CHECKING, OVERTIME, and for the dates mid-meetup check.
- Output: `{ label: "OK" | "NOT_OK" | "AMBIGUOUS" | "COMMAND", command?: "done"|"home"|"extend"|"cancel"|"moving", extendMin?: number, confidence: number }`.
- Rule pre-pass (wins over the model): explicit distress phrases → NOT_OK; "+30", "30 more," "another hour" → COMMAND extend; "home" → COMMAND home.
- Model post-check: if label is OK but confidence < 0.8, downgrade to AMBIGUOUS. If any distress lexicon term appears and the model says OK, downgrade to AMBIGUOUS.
- If the model call fails or exceeds 6 s, use the rule pre-pass result, else AMBIGUOUS.

### 9.4 Copy generation
- **Fixed templates (no LLM):** plan confirmation structure, guardian opt-in, guardian alerts and updates, all ladder messages, exit/alert word responses, closure, error messages. Templates live in `notify/templates.ts` with a small set of rotating variants.
- **LLM-phrased (bounded):** intake follow-up questions and small talk replies outside windows. The model receives question IDs and facts, returns ≤ 280 characters; a validator rejects outputs containing banned words (I10 list), markdown, em dashes, more than one emoji, or anything not grounded in the input facts. On rejection, fall back to a template.

### 9.5 Speech
- **STT:** OpenAI transcription API, model from env `STT_MODEL`. Input is the voice-note bytes from `content.read()`; convert with ffmpeg if needed.
- **TTS:** OpenAI text-to-speech, model and voice from env (`TTS_MODEL`, `TTS_VOICE`). Used for (a) voice-note replies, (b) the fake call script, (c) the guardian alert call. Pre-render and cache fake call audio per user at onboarding so the exit call starts fast.
- Output for iMessage voice notes: AAC in an `.m4a` container, `audio/mp4`.

---

## 10. Calls (fake call, check-in call, guardian alert call)

### 10.1 Transport
Photon Spectrum Voice lets a SIP application place calls through a Spectrum iMessage line. Verified facts (Stable docs):
- SIP server `sip.spectrum.photon.codes`; TLS on 5061 (preferred) or TCP on 5060; **UDP is not supported**.
- Username = Spectrum project ID, password = project secret. **Registration off** (trunk/no-registration mode).
- Caller ID (From) must be an iMessage line owned by the project, in E.164; otherwise 403.
- Audio is G.711 (PCMU/PCMA). RTP flows directly between the carrier and your SIP endpoint.
- SDK call control in `spectrum-ts` is not available yet; connect directly over SIP.
- A business profile is optional; unregistered outbound calls may be flagged.

### 10.2 Implementation: LiveKit Cloud SIP (primary)
- Use LiveKit Cloud (hosted, so no SIP or RTP touches the Windows PC). Create one **outbound SIP trunk** pointing at `sip.spectrum.photon.codes`, transport TCP (port 5060) unless LiveKit supports TLS for outbound trunks in the current docs (then prefer TLS/5061), `auth_username` = project ID, `auth_password` = project secret, numbers = [Batman's line E.164].
- To place a call: create a room, then `CreateSIPParticipant` (via `livekit-server-sdk` `SipClient`) with the trunk ID, the destination E.164, and the room name.
- Audio in the room: a small bot participant using `@livekit/rtc-node` that publishes an audio track from the pre-rendered TTS PCM (resample to the rate the SDK requires). For the fake call, play the script with natural pauses; for check-in calls and guardian calls, play the message twice then hang up.
- Confirm `@livekit/rtc-node` installs on Windows x64 in Spike S2. If it doesn't, move the audio bot to a LiveKit Agents worker deployed to LiveKit Cloud, or play audio via LiveKit's server-side ingress; record the choice.
- Verify all LiveKit method names against current LiveKit docs before coding; record them in `docs/PHOTON_NOTES.md`.

### 10.3 Call scripts
- **Fake call (exit):** voice of the decoy caller (mom, roommate, or boss; default roommate). Script: "Hey, it's me. Sorry, I really need you to come home, something happened with the apartment. Can you leave now? ... Okay. ... Okay, see you soon." Include 2 to 3 s pauses so the user can talk over it.
- **Check-in call (L2):** discreet, sounds like the decoy caller: "Hey, just checking on you. Text me back when you get a sec." Batman also texts L2 copy right after the call ends. The call itself never says "Batman" or "safety" (I10).
- **Guardian alert call:** Section 5.2. This one does identify Batman (it goes to the guardian, not the user).

### 10.4 Fallbacks and spike dependency
- If Spike S2 shows outbound voice is unavailable on our plan/line type: implement `CallService` with a `VoiceNoteFallback` that sends a TTS voice note plus text (exit), and for L2 sends a voice note plus `notifySilenced`. Keep the interface identical so the real SIP path can be swapped in later.
- Never block the alert text on the call. Text first, then call.

---

## 11. Photon integration specification

### 11.1 Accounts, plans, and lines
- The human already has a Photon project and API credentials. Credentials go in `.env` (Section 19), never in chat or code.
- Install the Photon CLI on Windows with `npx @photon-ai/cli login` (Node 18+). Useful: `photon projects ls`, `photon spectrum lines ls`, `photon spectrum users ls`.
- Line models (Stable docs): **Free/Pro = shared pool** (each end user is routed through a number from a shared pool; the number may differ across recipients; no group creation). **Business = dedicated** (all users text the same project-owned number).
- Check the project type with `GET /projects/{projectId}/imessage/` (returns `shared` or `dedicated`).
- Shared-pool users are created through the Spectrum API `POST /projects/{projectId}/users` with `{ "type": "shared", "phoneNumber": "+1..." }`, which assigns a pool number (`assignedPhoneNumber`). `GET /users/{userId}/redirect` returns an `sms:` deep link to start a conversation. Spike S5 confirms whether unregistered numbers (like a brand-new guardian) can receive messages on our plan.
- Build `scripts/admin-add-user.ts`: given a phone number, calls `POST /users` (shared or dedicated per project type), prints the assigned Batman number and the redirect link. Guardians are registered automatically by the server when added (if Spike S5 requires it).
- Management API: base `https://spectrum.photon.codes`, HTTP Basic auth `projectId:projectSecret`, JSON envelope `{ succeed, data }`. Branch on HTTP status first. OpenAPI spec: `https://spectrum.photon.codes/openapi/json`.

### 11.2 spectrum-ts setup

```ts
import { Spectrum, Emoji, voice, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";

const providers = [imessage.config()];             // auto-discovers lines, renews tokens
if (env.ENABLE_TERMINAL === "1") providers.push(terminal.config()); // dev only

const app = await Spectrum({
  projectId: env.SPECTRUM_PROJECT_ID,
  projectSecret: env.SPECTRUM_PROJECT_SECRET,
  providers,
  options: { logLevel: env.LOG_LEVEL ?? "info" },
});

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  await inbound.handle(space, message);   // never throw out of the loop
}
```

- Use the cloud provider (`@spectrum-ts/imessage`). Do **not** install `@spectrum-ts/imessage-local` anywhere; it requires a Mac.
- Terminal messages carry `message.platform === "terminal"`. In terminal mode, treat the console as a fake user with a configurable address and use `LOCATION_SOURCE=replay`; Find My and calls are stubbed.
- Call `app.stop()` on SIGINT/SIGBREAK/SIGTERM (Spectrum does not register signal handlers).
- Prefer the stream over webhooks (no public URL needed, which matters on a home Windows PC). If webhooks are ever used: raw body, HMAC verification, dedupe on `message.id`, and handlers are fire-and-forget.

### 11.3 advanced-imessage client (for locations, Focus, Notify Anyway, availability)
- Package: `@photon-ai/advanced-imessage`. Client: `createClient({ address, token })`, where `address` is `host:port` without scheme and `token` may be a function returning a Promise (use this for auto-refresh).
- Token: `POST https://spectrum.photon.codes/projects/{projectId}/imessage/tokens` with Basic auth. Response is either `{ type: "dedicated", auth: {instanceId: token}, numbers: {instanceId: phone}, expiresIn }` or `{ type: "shared", token, expiresIn }`. Refresh at 80% of `expiresIn`.
- **Address:** the docs do not state the gRPC host for our line. Spike S1 finds it by reading the installed `@spectrum-ts/imessage` source in `node_modules` (how it builds clients from minted tokens) and records it in `docs/PHOTON_NOTES.md` and `IMESSAGE_GRPC_ADDRESS`.
- Namespaces used:
  - `im.locations.request(chatGuid, address, { clientMessageId })`, `im.locations.get(address)`, `im.locations.watch(address)`.
  - `im.addresses.isIMessageAvailable(address)`, `im.addresses.isFocusSilenced(address)`.
  - `im.messages.notifySilenced(chatGuid, messageGuid)` (Notify Anyway) after sending an L1+ message or guardian alert when Focus is on.
  - `im.chats.create([address])` to get a `chat.guid` (DM GUID shape `any;-;{recipient}`).
- Message GUID mapping: Spectrum `Message.id` for iMessage should be the iMessage GUID; verify in Spike S1. If not, look up the sent message with `im.messages.listInChat(chatGuid, { pageSize: 5, isFromMe: true })`.
- Error handling: retry only retryable errors; use `clientMessageId` for idempotent retries.

### 11.4 Feature map

| Need | Photon feature | Package | Plan risk |
|---|---|---|---|
| Receive/send texts | `app.messages`, `space.send` | spectrum-ts cloud | none |
| Typing indicator | `space.responding` | spectrum-ts cloud | none |
| Tapbacks | `message.react(Emoji.like)` | spectrum-ts cloud | none |
| Threaded reply | `message.reply(...)` | spectrum-ts cloud | none |
| Voice notes in/out | `voice` content, `voice()` builder | spectrum-ts cloud | none |
| Contact card in (guardian) | `contact` content | spectrum-ts cloud | none |
| Share Batman's contact card | native contact card sharing | spectrum-ts cloud | none |
| Find My request/read/watch | `im.locations.*` | advanced-imessage | **Spike S1** |
| Focus check + Notify Anyway | `im.addresses.isFocusSilenced`, `im.messages.notifySilenced` | advanced-imessage | Spike S1 |
| iMessage availability | `im.addresses.isIMessageAvailable` | advanced-imessage | low |
| Outbound calls | Spectrum Voice over SIP | LiveKit Cloud SIP | **Spike S2** (caller ID must be a project-owned line) |
| Register users | `POST /projects/{id}/users` | Spectrum API | Spike S5 |
| Dev chat without a phone | terminal provider | spectrum-ts | none |

---

## 12. Data model (SQLite, Drizzle)

```
users(id, address_e164 UNIQUE, display_name, tz, onboarding_step, exit_phrase, alert_phrase,
      decoy_caller ENUM(mom, roommate, boss), home_lat NULL, home_lng NULL,
      reply_with_voice BOOL, created_at, deleted_at)
guardians(id, address_e164 UNIQUE, display_name, created_at, stopped_at)
user_guardians(user_id, guardian_id, status ENUM(pending, accepted, declined, expired, revoked),
      requested_at, responded_at, PRIMARY KEY(user_id, guardian_id))
plans(id, user_id, guardian_id, state, type, start_at, end_at, grace_min, venue_text, venue_lat,
      venue_lng, venue_place_type, counterpart_name, counterpart_source, transport,
      first_time_in_person, buy_or_sell, private_address, high_vigilance, notify_guardian_start_end,
      location_mode ENUM(findmy, pin, none), ladder_step, ladder_class, ladder_started_at,
      escalated_at, guardian_ack_at, closed_at, created_at, updated_at)
plan_events(id, plan_id, at, kind, data_json)          -- audit log; no coordinates after purge
location_fixes(id, plan_id, at, lat, lng, accuracy_m, location_type, source, received_at)
jobs(id, run_at, kind, plan_id, payload_json, status ENUM(pending, running, done, failed, cancelled),
     attempts, last_error, created_at)
messages(id, platform_message_id UNIQUE, direction, address_e164, plan_id NULL, kind, body_redacted,
         sent_at)                                       -- body stored redacted (code words masked)
processed_inbound(message_id PRIMARY KEY, at)
counters(day, key, value)                               -- quotas
locks(name PRIMARY KEY, holder, acquired_at, heartbeat_at)
```

Rules:
- Never store code words in `messages.body_redacted`; replace with `[code]`. Store code words themselves hashed plus a normalized form needed for matching; never log them.
- Purge job deletes `location_fixes` for plans closed > 24 h, and strips coordinates from `plan_events.data_json`.
- Database file lives under `data/` (gitignored).

---

## 13. Claude Code setup: CLAUDE.md, settings, and subagents

### 13.1 `CLAUDE.md` (create verbatim at repo root)

```markdown
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
```

### 13.2 `.claude/settings.json`

```json
{
  "permissions": {
    "allow": [
      "Bash(pnpm *)",
      "Bash(npx *)",
      "Bash(node *)",
      "Bash(git *)",
      "Bash(winget list*)",
      "PowerShell(pnpm *)",
      "PowerShell(node *)",
      "WebFetch(domain:photon.codes)",
      "WebFetch(domain:spectrum.photon.codes)",
      "WebFetch(domain:docs.livekit.io)",
      "WebFetch(domain:platform.openai.com)"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./data/**)",
      "Bash(cat .env*)",
      "Bash(type .env*)",
      "PowerShell(Get-Content .env*)"
    ]
  },
  "env": {
    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "8"
  }
}
```

Notes:
- `.env.example` stays readable; only real secret files are denied.
- If Claude Code can't find Git Bash, add `"CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"` under `env`.
- Check the exact permission rule syntax for the installed Claude Code version (`/permissions`), and adjust if a rule is rejected. The intent is: allow the project's normal commands, deny any way of reading secrets.
- Subagents can nest up to three levels by default and up to 20 can run at once; this project caps concurrency at 8 to keep the PC responsive.

### 13.3 Subagents (`.claude/agents/*.md`)

Each file is Markdown with YAML frontmatter; the body is the subagent's system prompt. `isolation: worktree` gives an agent its own git worktree, so parallel writers don't collide (the repo must be a git repo with at least one commit).

`.claude/agents/docs-researcher.md`
```markdown
---
name: docs-researcher
description: Read-only API verifier. Use proactively before anyone codes against Photon, LiveKit, or OpenAI. Returns exact signatures with sources.
tools: Read, Grep, Glob, WebFetch, WebSearch
model: sonnet
color: cyan
---
You verify APIs. You never write product code.
For Photon, use only Stable docs (https://photon.codes/docs/llms.txt and linked .md pages) and
the OpenAPI spec at https://spectrum.photon.codes/openapi/json. Never mix in /docs/beta/ pages.
Also read type definitions in node_modules (@spectrum-ts/*, @photon-ai/advanced-imessage,
livekit-server-sdk, @livekit/rtc-node, openai) because installed versions are the ground truth.
Return: exact import paths, function signatures, required options, return shapes, error types,
and a link or file path for each. Flag any mismatch with docs/BATMAN_SPEC.md explicitly.
Write or update docs/PHOTON_NOTES.md only when the main conversation asks you to.
```

`.claude/agents/integration-engineer.md`
```markdown
---
name: integration-engineer
description: Owns the Photon gateway, advanced-imessage client, Spectrum management API, LiveKit SIP calls, STT/TTS, the probe line, and Phase 0 spikes.
tools: Read, Write, Edit, Grep, Glob, Bash, PowerShell, WebFetch
model: opus
permissionMode: acceptEdits
isolation: worktree
color: blue
---
You own apps/server/src/gateway, location/findmy.ts, location/pin.ts, calls/, speech/,
apps/probe, and scripts/spike-*.
Follow spec Sections 8.4, 8.5, 10, 11, and 16.3 exactly. Use docs-researcher output; never guess APIs.
Every external call: zod-validate responses, retry with backoff only on retryable errors, and log
phone numbers redacted to the last 4 digits. Never read .env; scripts load it at runtime.
For spikes: write a runnable script, run it against the real project, and record inputs, outputs,
and a clear PASS/FAIL plus the chosen design branch in docs/SPIKES.md. If a spike needs the
human's iPhone, stop and return the exact steps the human must take.
Code must run on Windows (PowerShell and Git Bash). Never install @spectrum-ts/imessage-local.
```

`.claude/agents/core-engineer.md`
```markdown
---
name: core-engineer
description: Owns the plan state machine, escalation ladder, durable scheduler, risk engine, geometry, store schema, and admin commands.
tools: Read, Write, Edit, Grep, Glob, Bash, PowerShell
model: opus
permissionMode: acceptEdits
isolation: worktree
color: green
---
You own plan/, scheduler/, risk/, store/, util/clock.ts, admin/.
Implement spec Sections 6, 7, and 12 as pure, testable modules with an injected Clock.
State transitions are table-driven and exhaustively unit-tested (every row in Section 6.2).
Jobs are idempotent and survive restarts. setTimeout is never the source of truth.
The risk engine is rules only (Section 7.3). No ML, no LLM.
Write tests first for each transition and trigger, then implement.
```

`.claude/agents/conversation-engineer.md`
```markdown
---
name: conversation-engineer
description: Owns onboarding, intake, guardian dialogue, NLU prompts and schemas, the code word matcher, copy templates, and NLU eval datasets.
tools: Read, Write, Edit, Grep, Glob, Bash, PowerShell
model: opus
permissionMode: acceptEdits
isolation: worktree
color: purple
---
You own dialogue/, nlu/, pipeline/codewords.ts, notify/, and tests/evals/.
Follow spec Sections 4, 5, and 9. Code word matching is deterministic and runs before any LLM call.
Safety-critical copy uses fixed templates (Section 9.4). LLM-phrased copy passes the validator
(no banned words during windows, no markdown, no em dashes, at most one emoji, at most 280 chars).
Build eval datasets: at least 300 labeled check-in replies (sarcasm, typos, slang, voice-transcript
noise, indirect distress), 150 intake first messages across the four meetup types, and a 2,000
message benign corpus for code word false positives. Targets are in Section 7.5.
Write reports to reports/evals/.
```

`.claude/agents/test-engineer.md`
```markdown
---
name: test-engineer
description: Use proactively after any feature lands. Writes unit, invariant, and simulation tests, replay tracks, and maintains pnpm verify.
tools: Read, Write, Edit, Grep, Glob, Bash, PowerShell
model: sonnet
permissionMode: acceptEdits
color: yellow
---
You own tests/unit, tests/invariants, tests/sim, tests/fixtures, and the verify pipeline.
Implement every scenario in spec Section 15.3 as a deterministic simulation using the fake clock
and replay tracks with realistic GPS noise. Each invariant I1 to I16 gets at least one test.
Tests assert outbound messages (recipient, template id, order) and state transitions.
Never mock the plan engine or risk engine in sim tests; mock only Photon, LiveKit, and OpenAI.
Tests must pass identically in PowerShell and Git Bash.
```

`.claude/agents/live-test-runner.md`
```markdown
---
name: live-test-runner
description: Runs live end-to-end tests over real iMessage using the probe line, collects transcripts and logs, and writes failure reports. Does not fix product code.
tools: Read, Write, Grep, Glob, Bash, PowerShell
model: sonnet
background: true
color: orange
---
You own apps/probe runs and reports/live/.
Follow spec Section 16. Start the server (pnpm dev) with the TIME_SCALE and LOCATION_SOURCE each
scenario requires, run pnpm e2e:probe for the requested scenarios, and capture the full transcript
(sent, received, timestamps) plus relevant server log lines.
On failure, write reports/live/<timestamp>-<scenario>.md with expected vs actual transcript, log
excerpts, the suspected component, and a minimal repro. Hand the report back; do not edit
product code. Never message any number other than the configured probe and Batman numbers.
Stop the server when done.
```

`.claude/agents/safety-reviewer.md`
```markdown
---
name: safety-reviewer
description: Read-only reviewer. Use after every phase and before any demo. Checks changes against safety and privacy invariants I1 to I16 and the discretion rules.
tools: Read, Grep, Glob, Bash
model: opus
effort: high
color: red
---
Review diffs like the owner of a safety product. Check each invariant in spec Section 3.
Look for: escalation decided by LLM output, code word paths that depend on a model call, location
read or stored outside a window, coordinates sent to anyone but the guardian during escalation,
safety words in user-facing copy during windows, missing STOP handling, logs with full phone
numbers or coordinates, secrets in code or logs, and timers that would not survive a restart or a
Windows sleep/wake. Use git diff to see changes; never modify files.
Report concrete findings with file and line references and a proposed fix. No style nits.
```

### 13.4 How the main conversation uses subagents
- **Phase 0:** spawn `docs-researcher` to produce verified notes for `docs/PHOTON_NOTES.md`. Then spawn **five `integration-engineer` subagents in parallel**, one per spike (S1, S2, S4, S5, S6; S3 joins S1). Collect their results, batch any iPhone steps into one request to the human, then decide design branches in `DECISIONS.md`.
- **Phases 1 to 3:** `core-engineer` and `conversation-engineer` in parallel (disjoint directories, separate worktrees). Merge their worktree branches in the main conversation. `test-engineer` follows each merge.
- **Phases 4 to 6:** three in parallel: `integration-engineer` (location, calls), `core-engineer` (risk engine, ladder), `conversation-engineer` (ladder copy, guardian flows). Then `test-engineer`.
- **After every phase:** `safety-reviewer` on the phase diff (in parallel with `test-engineer` coverage checks), fix findings, then `live-test-runner` in the background for the phase's live scenarios while the main conversation continues with the next non-overlapping work.
- Write-heavy agents never edit the same files concurrently. If two tasks need the same file, run them serially.
- Each subagent's final message must include: files changed, tests added, commands run with results, and open questions. The main conversation records outcomes in `PROGRESS.md`.

---

## 14. Build phases and exit criteria

### Phase 0: Environment, then spikes
**0a. Windows environment (main conversation, first 15 minutes)**
- Check: `node -v` (LTS), `corepack enable`, `pnpm -v`, `git --version`, ffmpeg on PATH. Install missing tools with winget (`OpenJS.NodeJS.LTS`, `Git.Git`, `Gyan.FFmpeg`) only after asking the human.
- `git init`, `.gitignore` (node_modules, .env, .env.*, !.env.example, data/, logs/, reports/live/), `.gitattributes`, first commit (needed for worktree isolation).
- Create `.env.example` from Section 19 and ask the human to create `.env` from it.
- `pnpm doctor` must show all required variables present (names only) and a successful Photon API auth call (`GET /projects/{id}/`).

**0b. Spikes (parallel)**

| Spike | Question | Method | PASS means |
|---|---|---|---|
| **S1** | Can our project read Find My locations? What is the advanced-imessage gRPC address for our line type? Does Spectrum `Message.id` equal the iMessage GUID? | Mint token via `POST /imessage/tokens`; find address in `@spectrum-ts/imessage` source; `createClient`; `im.chats.create([humanIphone])`; `im.locations.request(...)`; human accepts on iPhone; `im.locations.get(humanIphone)`; run `watch()` for 5 min while the human walks | coordinates received with `locationType: "live"`; updates arrive while moving |
| **S2** | Can we place an outbound call from Batman's line to a real phone? What caller ID shows? Does `@livekit/rtc-node` install on Windows? | LiveKit outbound trunk to `sip.spectrum.photon.codes`, `CreateSIPParticipant` to the human's iPhone, play a TTS clip | phone rings, shows Batman's line, two-way audio works |
| **S3** | Inbound voice note format | human sends a voice note; log `content` | `type: "voice"`, `read()` returns bytes STT can handle |
| **S4** | Format of an iMessage "Send My Current Location" pin | human sends a pin; log the raw message | parser extracts lat/lng (record the exact format) |
| **S5** | Shared pool: can Batman start a DM with an unregistered number (guardian)? What number do they see? | try `space.create(user(guardianPhone))` and send; if it fails, register via `POST /users` and retry | guardian receives the message; registration requirement documented |
| **S6** | Can a second Photon project (the probe) and Batman's line text each other, so live tests run without a phone? | create or use a second project, register numbers as Section 16.3 describes, send both directions | messages flow both ways within 10 s |

Exit: `docs/SPIKES.md` has PASS/FAIL for each and the chosen branch:
- S1 FAIL → `LOCATION_SOURCE=pin` mode: Batman asks the user to drop a pin at arrival and when leaving, and relies more on time-based check-ins. Also ask Photon (Section 20) and consider a dedicated line for the demo.
- S2 FAIL → voice-note fallback (Section 10.4).
- S5 requires registration → guardian onboarding calls the Users API first.
- S6 FAIL → live testing uses the guided iPhone runner only (Section 16.4).

### Phase 1: Skeleton
- pnpm workspace, env loader with zod, SQLite + migrations, lock, logging, Clock, `Channel` interface.
- Spectrum gateway with echo, typing indicator, and tapback; dedupe; read-receipt handling. Terminal provider wired behind `ENABLE_TERMINAL`; `pnpm chat` works.
- Exit: the human texts Batman's line and gets an echo; `pnpm chat` echoes in the console; restart the server twice and confirm no duplicate replies.

### Phase 2: Onboarding and guardian consent
- Sections 4.2 and 4.3 flows, code word validation, contact card intake and share, STOP handling.
- Exit: unit + invariant tests (I1, I13, I14, I15) green; full onboarding works in `pnpm chat`; live onboarding works from the human's iPhone with a real guardian phone (or the probe as guardian).

### Phase 3: Intake and arming
- Extractor, question policy, time parsing and confirmation, geocoding, plan confirmation, edits, cancel.
- Exit: intake evals ≥ 95% field accuracy on the 150-message set; median turns to arm ≤ 3; live run arms a date, a marketplace meetup, and a viewing.

### Phase 4: Scheduler, overtime, ladder (time-only)
- Durable jobs, overtime, ladder L0 to L3 with templates, guardian alert text, guardian commands, closure.
- Exit: sim scenarios S-01 to S-06 pass; restart-during-ladder test passes (I16).

### Phase 5: Location and risk engine
- Find My request/acceptance, watcher with heartbeat, pin parser, geometry, triggers, suppression, high-vigilance.
- Exit: all replay scenarios pass; arrival/departure accuracy target met; live walk test with the human's iPhone detects arrival and departure (or pin-mode equivalent if S1 failed).

### Phase 6: Exits and calls
- Code words on text and voice notes, exit flow with fake call, alert flow, check-in call (L2), guardian alert call, fallbacks.
- Exit: code word evals 100% recall and < 0.5% false positives; live: exit word → iPhone rings within 20 s; alert word → guardian gets text and call within 15 s.

### Phase 7: Hardening, privacy, and hosting
- Purge job, redaction, quota counters, error paths (Photon down, OpenAI down, LiveKit down), admin commands, demo mode, Windows sleep handling (Section 17).
- Exit: safety-reviewer reports no open findings; chaos tests pass (kill process mid-ladder, drop location stream, LLM timeout, simulated sleep/wake gap).

### Phase 8: Live verification with real Photon credentials (final)
- Full probe E2E suite, then the guided iPhone session (Section 16.4) against the real project.
- Exit: Section 18 checklist complete.

---

## 15. Testing strategy

### 15.1 Layers
1. **Unit:** geometry, triggers, code word matcher, time parsing, templates, validators, phone normalization.
2. **Invariant tests:** one or more per I1 to I16 (e.g., I10 test scans every template used in window states for banned words; I2 test feeds a `list()` result containing other addresses and asserts they're dropped).
3. **NLU evals:** datasets in `tests/evals/`; the runner computes metrics and writes `reports/evals/<date>.md`. Fail the run if below targets.
4. **Simulation:** full server logic with fake clock, fake `Channel` (records sends), fake LocationSource replaying tracks, fake CallService. Assert exact outbound sequences.
5. **Console chat:** `pnpm chat` uses the terminal provider so a human (or Claude Code) can converse with the real dialogue logic on Windows with no phone.
6. **Live probe E2E:** Section 16.3 (real iMessage, no phone).
7. **Guided iPhone session:** Section 16.4 (real phone, real Find My, real calls).

### 15.2 Replay track format

```json
{
  "name": "date-normal",
  "venue": { "lat": 41.9172, "lng": -87.7067 },
  "home": { "lat": 41.8990, "lng": -87.6650 },
  "noise": { "sigmaM": 30, "outlierRate": 0.03, "outlierM": 300, "seed": 7 },
  "fixes": [
    { "t": "-00:20", "lat": 41.9001, "lng": -87.6700, "accuracyM": 15 },
    { "t": "+00:01", "lat": 41.9171, "lng": -87.7066, "accuracyM": 20 }
  ],
  "userMessages": [ { "t": "+02:05", "text": "done" } ]
}
```
Times are relative to plan start. The replay engine applies noise deterministically from the seed.

### 15.3 Required scenarios (simulation; live where marked ★)

| ID | Scenario | Expected outcome |
|---|---|---|
| S-01 ★ | Date, arrive, leave on time, text "home" | arrival line; no check-ins; closure; guardian hears nothing |
| S-02 ★ | Date runs 40 min over, user replies "+30" | overtime msg; extension confirmed; no guardian contact |
| S-03 ★ | Overtime, no reply at all | L1 at T1, L2 call, L3 guardian text + call; updates every 3 min until GOT IT |
| S-04 | Overtime, user replies "yeah lol" at L1 | resolved; 👍 tapback; no guardian contact |
| S-05 | Overtime, user replies "not really" | NOT_OK → L3 immediately + exit call offered |
| S-06 | Restart server during L1 | after restart, L2 fires at the correct time; no duplicate L1 |
| S-07 | Marketplace at public spot, done in 15 min | no triggers; closure |
| S-08 | Marketplace at private address, user departs at vehicle speed 8 min in, no "done" | high vigilance; T-DEP-CAR; ladder with 0.6× timers |
| S-09 | Date, user walks to a bar 400 m away, stays 30 min | "New spot? 🙂" only; no ladder if answered |
| S-10 | Date, location goes dark for 12 min mid-date | T-DARK; ladder; if user replies "phone died lol" → resolved |
| S-11 | Viewing, indoor GPS drifting 180 m | no false departure (radius 250 m + hysteresis) |
| S-12 ★ | Exit word mid-date | innocuous reply < 2 s; call placed < 20 s; post-exit watch |
| S-13 ★ | Alert word | innocuous reply; guardian text + call < 15 s; no user-facing hint |
| S-14 | Exit word with one typo ("pinaple") | detected (≥ 5 letters, distance 1) |
| S-15 | Benign message "pineapples are gross" | token "pineapples" is distance 1 from "pineapple" so it **matches**; the test documents this, and onboarding validation steers users to unusual words |
| S-16 ★ | Voice note containing the alert word | transcribed; alert flow |
| S-17 | No Find My share | time-only mode; overtime works; no location triggers |
| S-18 | Guardian never accepted, user tries to arm | AWAITING_GUARDIAN; clear message; plan not armed |
| S-19 | Guardian texts STOP | no further messages to guardian; user told |
| S-20 | User texts "he won't let me leave" | explicit distress → L3 + exit call |
| S-21 | `list()` returns another person's location | ignored (I2) |
| S-22 | LLM API down during CHECKING, user replies "im good" | rule pre-pass resolves OK; no crash |
| S-23 | LiveKit down at exit word | voice-note fallback within 5 s |
| S-24 | Quota near cap | safety messages still sent; onboarding paused |
| S-25 | Host asleep for 20 min during ACTIVE (clock jumps) | on wake: overdue jobs run once, in order, ladder continues correctly, no duplicate sends |

### 15.4 Time compression
- `TIME_SCALE` env (default 1). With `TIME_SCALE=60`, a 2-hour date runs in 2 minutes. The Clock, scheduler polling, ladder timers, and replay tracks all honor it.
- Admin command `/ff <minutes>` (from `ADMIN_NUMBERS` only, demo or test mode only) fast-forwards the plan clock for live demos.

---

## 16. Live testing from Windows and the refinement loop

There is no Messages app on Windows, so live testing uses two complementary paths: a **probe line** (automated, no phone) and a **guided iPhone session** (human in the loop, needed for Find My and real calls).

### 16.1 Test control port
When `TEST_MODE=1`, the server exposes `http://127.0.0.1:${TEST_CONTROL_PORT}` (bound to loopback only, never enabled in demo or production) with endpoints:
- `GET /state?user=+1...` → current plan state, ladder step, last outbound message ids and template ids (no secrets, no code words).
- `POST /replay` `{ track: "date-normal" }` → switch the user's LocationSource to a replay track.
- `POST /ff` `{ minutes: 30 }` → fast-forward.
- `POST /reset` `{ user: "+1..." }` → delete a test user's data.
- `GET /outbox?since=...` → outbound messages sent (redacted), so tests can assert guardian messages even when the guardian is a real phone.

### 16.2 Console chat (`pnpm chat`)
- Runs the server with `ENABLE_TERMINAL=1`, `LOCATION_SOURCE=replay`, stubbed calls (printed as `[CALL → user: fake call script]`), and the guardian simulated as a second console identity (`/as guardian` and `/as user` switch who is typing).
- This is the fastest loop for conversation work and the first thing to run after any dialogue change.

### 16.3 Probe E2E (`pnpm e2e:probe`)
- The probe is a **second Photon project** (free tier is fine) whose cloud line acts as a scripted iMessage user or guardian. `apps/probe` uses `spectrum-ts` with `PROBE_PROJECT_ID`/`PROBE_PROJECT_SECRET`, sends texts to Batman's line, and reads Batman's replies from its own `app.messages` stream. All of this runs on Windows.
- Registration (shared pool): Batman's project registers the probe line's number as a user, and the probe project registers Batman's number as a user, so each side has an assigned route to the other. Spike S6 determines the exact steps (and whether a chicken-and-egg ordering problem exists on shared pools; if it does, one side needs a dedicated line or the probe falls back to receive-first flows). Record the procedure in `docs/SPIKES.md`.
- The probe cannot share a Find My location, so probe scenarios use `POST /replay` for movement. Calls to the probe line are not answerable; assert call attempts via `GET /outbox` and server logs.
- Each scenario is a script of steps: `send(text)`, `expect(regex, withinSec)`, `expectNone(withinSec)`, `wait(sec)`, `control(endpoint, body)`. Output: `reports/live/<timestamp>/<scenario>.json` (transcript) and a summary with pass/fail and reply latency (p50/p95).
- Scenarios: all ★ scenarios in Section 15.3 except those needing real calls answered or real Find My, plus:
  - E-ONB: full onboarding from a fresh probe user (reset first).
  - E-INTAKE-3: arm a date, a marketplace, and a viewing from natural first messages, each within 3 turns.
  - E-LAT: 20 pings; target p95 < 4 s for non-LLM paths and < 8 s for LLM paths.
  - E-GUARDIAN: the probe plays the guardian (user simulated through the control port), verifying opt-in, alert text format, GOT IT, and STOP.

### 16.4 Guided iPhone session (`pnpm live:guide`)
A CLI script the human runs (or Claude Code runs while the human holds the phone). It prints one step at a time ("On your iPhone, text Batman: going on a date at 7 at Lula Cafe"), waits for Enter, then verifies Batman's side through the control port and logs, printing PASS/FAIL per step and writing `reports/live/guide-<timestamp>.md`. It covers what automation can't:
1. Onboard from the iPhone; save Batman as "Mom"; confirm lock-screen previews look like a normal friend's texts.
2. Accept the Find My card with "Share Until End of Day"; Batman detects it within 60 s.
3. Walk 300 m away from the venue (or switch to a replay track if testing indoors) with the phone locked; L0 arrives.
4. Ignore L0 and L1; the phone rings at L2 and sounds like the decoy caller with no safety words.
5. Let L3 fire; the guardian phone gets the alert text with a working Apple Maps link and an alert call.
6. Reply GOT IT from the guardian; cadence drops; reply "im ok" from the user; the guardian gets the update.
7. Text the exit word; the phone rings within 20 s.
8. Turn on a Focus mode on the guardian phone; trigger L3; Notify Anyway breaks through.
9. Text "home"; closure and guardian all-clear (if escalated).
10. "delete my data"; deletion confirmed.

### 16.5 Refinement loop (run until done)
```
repeat:
  pnpm verify                         # must be green before any live run
  pnpm e2e:probe --scenarios all      # TIME_SCALE=60 unless a scenario requires 1
  if all pass on 3 consecutive runs:
      break
  for each failure report:
      main conversation triages → owning subagent fixes the root cause → adds or updates a
      sim test that reproduces it → pnpm verify
  record behavior changes in DECISIONS.md
then: one guided iPhone session (16.4); any failure there re-enters the loop with a new sim test.
```
- Flaky tests are failures. Fix the cause (usually timing assumptions or missing dedupe); never add blind retries to assertions.
- If S6 failed (no probe), the loop uses `pnpm chat` scripted transcripts plus sim, and the guided iPhone session runs after every phase that touches messaging.

### 16.6 Human-in-the-loop checkpoints (batch these)
Claude Code needs the human for: creating `.env` and adding keys; Phase 0 spikes S1 (accept Find My, walk), S2 (answer a call), S3 (send a voice note), S4 (send a location pin), S5 (a guardian phone number that consents to test texts); the Phase 1 echo check; and the guided session. Ask for these together with exact steps, then wait. Never message anyone who hasn't agreed to receive test messages.

---

## 17. Hosting and the Windows sleep problem
- Batman is a safety product; if the host sleeps, check-ins stop. During development, a sleeping PC is fine. For the demo and any real use:
  - **Option A (simplest for the hackathon):** run on the Windows laptop, plugged in, with sleep disabled (`powercfg /change standby-timeout-ac 0` and `powercfg /change monitor-timeout-ac 0`; restore afterward). `pnpm doctor` warns if sleep is enabled.
  - **Option B (recommended after the demo):** deploy the same code to an always-on host as a background worker (Render, Fly.io, Railway, or a small VM). The Spectrum stream needs no public URL. Use a persistent disk for SQLite. Only one instance may run (Section 8.1).
- Onboarding disclosure (I13) mentions that Batman can fail if its host is offline; the demo talking points mention Option B.

---

## 18. Definition of done (acceptance checklist)
- [ ] `pnpm verify` green: typecheck, lint, unit, invariants, sim (all S-xx), evals at targets.
- [ ] `pnpm e2e:probe` green on 3 consecutive runs (or documented S6 fallback).
- [ ] Guided iPhone session (16.4) completed and recorded in `reports/live/guide-<date>.md`.
- [ ] safety-reviewer: no open findings.
- [ ] `docs/SPIKES.md`, `docs/PHOTON_NOTES.md`, `DECISIONS.md`, and `PROGRESS.md` complete and current.
- [ ] `.env.example` lists every variable in Section 19 with comments.
- [ ] README has: what Batman is, Windows setup in under 10 steps, how to run the demo, known limitations (phone dead/no signal, host asleep, Photon outage, plan-dependent features, not an emergency service).
- [ ] Demo mode script works end to end in under 4 minutes (Section 21).

---

## 19. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SPECTRUM_PROJECT_ID` | yes | Photon project ID (also SIP username) |
| `SPECTRUM_PROJECT_SECRET` | yes | Photon project secret (also SIP password) |
| `IMESSAGE_GRPC_ADDRESS` | if S1 needs it | advanced-imessage `host:port` |
| `BATMAN_LINE_E164` | yes | Batman's line (caller ID for calls) |
| `OPENAI_API_KEY` | yes | LLM, STT, TTS |
| `LLM_PROVIDER` | no | `openai` (default) or `anthropic` |
| `ANTHROPIC_API_KEY` | if anthropic | alternative LLM provider |
| `LLM_MODEL_SMART` | yes | extraction and classification model (pick a current model from the provider's docs) |
| `LLM_MODEL_FAST` | no | small talk and copy phrasing |
| `STT_MODEL` | yes | transcription model |
| `TTS_MODEL`, `TTS_VOICE` | yes | speech synthesis |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | if calls | LiveKit Cloud project |
| `LIVEKIT_SIP_TRUNK_ID` | if calls | outbound trunk to Photon (created by a setup script) |
| `GEOCODER` | yes | `mapbox`, `google`, or `nominatim` |
| `GEOCODER_API_KEY` | per provider | key (Nominatim needs a contact email in User-Agent and ≤ 1 req/s) |
| `FFMPEG_PATH` | no | if ffmpeg isn't on PATH |
| `DATABASE_PATH` | yes | e.g. `./data/batman.db` |
| `DEFAULT_TZ` | yes | `America/New_York` |
| `TIME_SCALE` | no | default 1 |
| `LOCATION_SOURCE` | no | `findmy` (default), `pin`, `replay`, `none` |
| `REPLAY_TRACK` | with replay | path to track JSON |
| `ENABLE_TERMINAL` | no | `1` enables the console provider |
| `DEMO_MODE` | no | enables `/ff` and demo copy tweaks |
| `TEST_MODE`, `TEST_CONTROL_PORT` | tests | loopback control port |
| `ADMIN_NUMBERS` | no | comma-separated E.164 numbers allowed to send admin commands |
| `HUMAN_IPHONE_E164` | live tests | the human's iPhone number for spikes and the guided session |
| `TEST_GUARDIAN_E164` | live tests | a consenting guardian phone for live tests |
| `PROBE_PROJECT_ID`, `PROBE_PROJECT_SECRET` | probe E2E | second Photon project for the probe line |
| `LOG_LEVEL` | no | `info` default |

---

## 20. Open questions for Photon (ask in their Discord early)
1. On Pro (shared pool), does `im.locations` work? Which gRPC address should `@photon-ai/advanced-imessage` use with a shared token?
2. On Pro, can Spectrum Voice place outbound calls (caller ID must be a project-owned line)? If not, can hackathon teams get a dedicated line?
3. Must new shared-pool users be registered via `POST /users` before Batman can message them first (e.g., a guardian)?
4. Can two Photon projects' lines message each other (for automated testing)? Any registration order needed?
5. Does using `@photon-ai/advanced-imessage` alongside `spectrum-ts` count as "integrating with Spectrum" for the prize?
6. Is Spectrum's `Message.id` the iMessage message GUID (needed for `notifySilenced`)?
7. Any rate limits on `im.locations.get()` polling (we plan 1 call per 60 s per active plan)?

---

## 21. Demo script (for judges, ~3.5 minutes, `DEMO_MODE=1`, `TIME_SCALE=60`)
1. **Setup shown on screen:** presenter's iPhone already onboarded; a teammate's phone is the guardian. The Windows laptop runs Batman, plugged in, sleep disabled.
2. **Voice-note intake:** "Hey, I've got a Marketplace pickup at 6, the guy's address is 214 Maple, it's a bike." Batman notices a private address, suggests a public spot in one line, asks "Should take about 20 min?" → "yep" → plan confirmation → "go."
3. **Find My:** accept the native card on stage.
4. **Fast-forward** to the meetup (`/ff 30`). Arrival line appears ("Have fun! Text me when you head out.").
5. **Exit word:** presenter texts "pineapple." Batman replies "lol ok," and the phone rings 10 seconds later as "Mom." Answer on speaker so the room hears the script.
6. **Silence test:** switch to a replay track with a fast car departure; presenter ignores L0 and L1; the phone rings (L2) and the presenter declines.
7. **Guardian alert:** the teammate's phone gets the alert text with a map link and an alert call; the teammate replies "GOT IT."
8. **Resolution:** presenter texts "im ok, was just driving"; the teammate gets "Alex just replied that they're okay."
9. **Close:** "home" → plan closed, data deletion message.
10. **Talking points:** iMessage-only and no Mac needed, consent at every step, deterministic escalation, discretion on the lock screen, deletion after 24 hours.

---

## 22. Known limitations to state honestly
- If the user's phone is dead or offline, Batman can only escalate on time (overtime, dark location), not detect anything specific.
- If Batman's host is asleep or offline, nothing runs until it wakes (Section 17).
- Find My location freshness depends on Apple; updates can lag by minutes.
- Calls depend on Photon Spectrum Voice and LiveKit; the fallback is voice notes and texts.
- Batman is not an emergency service and cannot dispatch help.
- Code words can be typed accidentally if users pick common words; onboarding validation reduces but doesn't eliminate this.
