# Batman

Batman is an iMessage contact that looks out for you when you meet a stranger: a first date, a Facebook Marketplace pickup, an apartment viewing. You text it your plan. It asks a few short questions, quietly watches your shared location for that window only, checks in when something looks off, rings your phone if you go quiet, and alerts the friend you chose if you still do not answer. Two secret code words give you a silent way out: one makes your phone ring with a fake call, the other quietly alerts your friend.

There is no app, website, or dashboard. The whole product is a conversation in Apple Messages. iMessage delivery runs on Photon's managed cloud lines, so the server is ordinary Node.js and needs no Mac.

"Batman" is a hackathon codename (HackNC 2026, Photon track). It is a DC Comics trademark and must be renamed before any public launch.

Full design: [docs/BATMAN_SPEC.md](docs/BATMAN_SPEC.md). Build state: [PROGRESS.md](PROGRESS.md). Decisions and deviations: [DECISIONS.md](DECISIONS.md). Verified API notes: [docs/PHOTON_NOTES.md](docs/PHOTON_NOTES.md).

## How it works

- **Plan.** "going on a date at 7 at Lula Cafe." Batman extracts what it can (Claude, structured output) and asks at most one follow-up message.
- **Arm.** You reply GO to the one-message plan summary.
- **Share.** Before the meetup Batman sends a native Find My request; you share with Batman only, until end of day.
- **Watch quietly.** Deterministic rules detect arrival, departure, fast departure by car, location going dark, and running late. No machine learning decides anything safety critical.
- **Escalate.** Text, second text with Notify Anyway, a phone call, then your guardian gets a text and a call with your last location.
- **Exits.** Exit word: your phone rings within about 20 seconds. Alert word: your guardian is alerted silently.
- **Close.** Text "home." Location data is deleted 24 hours later.

## Windows setup (about 10 minutes)

1. Install Node.js 22 or 24 LTS, Git for Windows, and ffmpeg (`winget install OpenJS.NodeJS.LTS Git.Git Gyan.FFmpeg`).
2. `corepack enable` so `pnpm` is available.
3. `git clone https://github.com/markandeyay/batman.git` and `cd batman`.
4. `pnpm install`.
5. Copy `.env.example` to `.env` and fill it in. Required: Photon project ID and secret, `ANTHROPIC_API_KEY`. Optional: `OPENAI_API_KEY` (voice notes and call audio), LiveKit (phone calls), a second Photon project for the automated probe.
6. Register your iPhone with the Photon project: `pnpm admin:add-user +1XXXXXXXXXX`. It prints the Batman number assigned to you; write it into `BATMAN_LINE_E164`.
7. If calls are configured: `npx tsx scripts/livekit-setup.ts` creates Batman's SIP trunk and writes `LIVEKIT_SIP_TRUNK_ID`.
8. `pnpm run doctor` checks the toolchain, that every required variable is present (names only), and Photon authentication. Use `pnpm run doctor`, not `pnpm doctor` (pnpm has a built-in command with that name).
9. `pnpm dev` starts the server. Text the Batman number from your iPhone.

No port forwarding, public URL, or firewall change is needed: every connection is outbound.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run the server with `.env` |
| `pnpm chat` | Talk to Batman in this console (terminal provider, replayed locations, stubbed calls) |
| `pnpm verify` | Typecheck, lint, unit, invariant, simulation tests, and evals |
| `pnpm test:sim` | Replay scenarios with a fake clock |
| `pnpm evals` | NLU eval suites, reports in `reports/evals/` |
| `pnpm e2e:probe` | Live end-to-end tests over real iMessage using the probe line |
| `pnpm live:guide` | Guided iPhone test session |
| `pnpm spike <name>` | Phase 0 spikes |
| `pnpm run doctor` | Environment check |

## Demo (about 3.5 minutes)

Run with `DEMO_MODE=1 TIME_SCALE=60` (one real second is one simulated minute) on a plugged-in laptop with sleep disabled (`powercfg /change standby-timeout-ac 0`). The presenter's iPhone is already onboarded and a teammate's phone is the guardian. The full script is in spec Section 21: voice-note intake for a Marketplace pickup, Find My share on stage, `/ff 30` to the meetup, exit word with a fake call, a fast car departure replay that runs the ladder to a guardian alert, the guardian replying GOT IT, the presenter replying "im ok", and "home" to close.

## Known limitations

- **Phone dead or offline.** Batman can only escalate on time (running late, location gone dark), not detect anything specific.
- **Host asleep or offline.** If the computer running Batman sleeps or loses its connection, nothing runs until it wakes; timers are durable and catch up, but that can be too late. For real use, deploy to an always-on host (spec Section 17).
- **Photon outage.** No messages in or out until Photon recovers.
- **Plan-dependent features.** On a shared-pool (Free or Pro) Photon project, Find My location, Focus status, Notify Anyway, and outbound calls may be unavailable; Batman falls back to location pins, time-based check-ins, and text instead of calls. See docs/spikes/ for what this project verified.
- **Location freshness** depends on Apple; Find My updates can lag by minutes.
- **Not an emergency service.** Batman never calls 911. It tells your guardian to call 911 if they believe you are in danger.
- **Code words** can be typed by accident if you pick common words; onboarding rejects risky choices but cannot rule this out.
- **Adults only.** Batman is for people 18 and over.
