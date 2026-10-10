# Phase 0b spike results

Detail per spike is in docs/spikes/. Design branches are recorded in DECISIONS.md.

| Spike | Question | Status (2026-10-10) | Design branch |
|---|---|---|---|
| S1 | Find My locations over advanced-imessage on our line | BLOCKED: every call targeting the human's number returns PERMISSION_DENIED "Target not allowed for this project" although the number is registered. `locations.list()` is unusable on a shared pool. | Pending iPhone step (text Batman first, check Apple handle). If still denied: `LOCATION_SOURCE=pin` (spec 14 S1 FAIL branch). |
| S2 | Outbound call from Batman's line via LiveKit SIP | PARTIAL PASS: trunk to sip.spectrum.photon.codes:5061 TLS created; rtc-node joins rooms and publishes audio on Windows. Call to iPhone pending. OpenAI TTS key returns 401. | Pending call test. On 403 (caller ID rejected) or failure: voice-note/text fallback (spec 10.4). |
| S3 | Inbound voice note format | PENDING iPhone. Logger and STT module ready; expected audio/x-caf, converted by ffmpeg. STT blocked by the OpenAI 401. | Voice notes transcribed when a working OpenAI key exists, else voice_unavailable reply. |
| S4 | "Send My Current Location" pin format | PENDING iPhone. Parser handles Apple Maps ll/q/coordinate URLs, Google Maps, .loc.vcf, GEO, geo: links. | Pin parser in location/pin.ts. |
| S5 | Can Batman message an unregistered number | ANSWERED (Stable docs + live pool-number error): no. | Guardian onboarding registers the guardian via POST /users/ first. |
| S6 | Can a probe project and Batman text each other | FAIL: pool numbers are rejected as recipients ("Target is a Photon-managed shared line"). | Live testing = guided iPhone session (16.4) + `pnpm chat` + sim. |
