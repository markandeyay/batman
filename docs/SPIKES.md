# Phase 0b spike results

Detail per spike is in docs/spikes/. Design branches are recorded in DECISIONS.md.

| Spike | Question | Status (2026-10-10) | Design branch |
|---|---|---|---|
| S1 | Find My locations over advanced-imessage on our line | PASS (request, acceptance in ~30 s, coordinates at 6.7 m, type shallow) once the user had texted Batman first. Movement streaming inconclusive: the host PC slept during the walk. `list()` unusable on shared pool. | `LOCATION_SOURCE=findmy` with the 60 s `get()` heartbeat. Users and guardians must text Batman first. |
| S2 | Outbound call from Batman's line via LiveKit SIP | PARTIAL PASS: trunk to sip.spectrum.photon.codes:5061 TLS created; rtc-node joins rooms and publishes audio on Windows. Call to iPhone pending. OpenAI TTS key returns 401. | Pending call test. On 403 (caller ID rejected) or failure: voice-note/text fallback (spec 10.4). |
| S3 | Inbound voice note format | NOT TESTED: text-only mode (no working OpenAI key). | voice_unavailable reply; AMBIGUOUS in CHECKING. |
| S4 | "Send My Current Location" pin format | FAIL: arrives as `custom` / `unsupported-message`, no coordinates. Contact cards PASS. Echo PASS (3.5 s inbound to reply). | Venues by typed address + geocoding, or a pasted Maps link (location/pin.ts). Reply loc_pin_unsupported to native pins. |
| S5 | Can Batman message an unregistered number | ANSWERED (Stable docs + live pool-number error): no. | Guardian onboarding registers the guardian via POST /users/ first. |
| S6 | Can a probe project and Batman text each other | FAIL: pool numbers are rejected as recipients ("Target is a Photon-managed shared line"). | Live testing = guided iPhone session (16.4) + `pnpm chat` + sim. |
