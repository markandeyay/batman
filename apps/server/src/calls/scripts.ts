// Call scripts (spec 10.3 and 5.2). Fixed copy, no LLM.
//
// I10: the fake call and the check-in call go to the user and sound like the decoy caller.
// They never say "Batman" or "safety". Only the guardian alert call identifies Batman.
//
// No spectrum-ts imports.
import type { DecoyCaller } from "../contracts.js";
import { concatPcm, silence, type SpeechRenderer, type VoiceStyle } from "../speech/tts.js";

export type CallScriptId = "fake" | "checkin" | "guardian_alert";

export type Segment = { say: string } | { pauseMs: number };

export interface CallScript {
  id: CallScriptId;
  style: VoiceStyle;
  segments: Segment[];
  /** How many times the whole script plays before hanging up (spec 10.2: check-in and guardian twice). */
  plays: number;
  /** Silence between plays. */
  gapMs: number;
}

/**
 * Voice per decoy caller. `voice` undefined means the configured default (env TTS_VOICE).
 * Voices are OpenAI built-ins listed in the installed SpeechCreateParams type (PHOTON_NOTES F).
 */
export const DECOY_VOICES: Record<DecoyCaller, VoiceStyle> = {
  mom: { voice: "coral", instructions: "A warm, slightly worried mother calling her adult child. Natural, casual phone voice." },
  roommate: { instructions: "A casual roommate calling a friend. Natural, a little hurried, everyday phone voice." },
  boss: { voice: "ash", instructions: "A busy but friendly manager calling an employee. Natural, direct phone voice." },
};

const GUARDIAN_STYLE: VoiceStyle = { instructions: "Calm, clear, and serious automated announcement. Speak slowly and clearly." };

/** Spec 10.3 fake call (exit). 2 to 3 s pauses so the user can talk over it. Played once. */
export function fakeCallScript(decoy: DecoyCaller): CallScript {
  return {
    id: "fake",
    style: DECOY_VOICES[decoy],
    segments: [
      { pauseMs: 800 },
      { say: "Hey, it's me. Sorry, I really need you to come home, something happened with the apartment. Can you leave now?" },
      { pauseMs: 3000 },
      { say: "Okay." },
      { pauseMs: 2500 },
      { say: "Okay, see you soon." },
      { pauseMs: 500 },
    ],
    plays: 1,
    gapMs: 0,
  };
}

/** Spec 10.3 check-in call (L2). Sounds like the decoy caller, played twice. */
export function checkinCallScript(decoy: DecoyCaller): CallScript {
  return {
    id: "checkin",
    style: DECOY_VOICES[decoy],
    segments: [{ pauseMs: 800 }, { say: "Hey, just checking on you. Text me back when you get a sec." }],
    plays: 2,
    gapMs: 1500,
  };
}

/** Spec 5.2 guardian alert call. Identifies Batman. Played twice. */
export function guardianAlertCallScript(userName: string): CallScript {
  const name = userName.trim() || "your friend";
  return {
    id: "guardian_alert",
    style: GUARDIAN_STYLE,
    segments: [
      { pauseMs: 800 },
      {
        say:
          `This is Batman, an automated safety assistant for ${name}. ` +
          `${name} hasn't responded during a meetup. I've texted you their last location. ` +
          `Please call ${name} now, and call 911 if you think they're in danger.`,
      },
    ],
    plays: 2,
    gapMs: 1500,
  };
}

export function callScript(id: CallScriptId, ctx: { decoy: DecoyCaller; userName: string }): CallScript {
  switch (id) {
    case "fake":
      return fakeCallScript(ctx.decoy);
    case "checkin":
      return checkinCallScript(ctx.decoy);
    case "guardian_alert":
      return guardianAlertCallScript(ctx.userName);
  }
}

/** All spoken text of a script (used by tests for the I10 wording check). */
export function spokenText(s: CallScript): string {
  return s.segments.map((g) => ("say" in g ? g.say : "")).join(" ").trim();
}

/** Renders one play of the script (with pauses) to 48 kHz mono PCM. TTS segments are cached by the renderer. */
export async function renderScript(tts: SpeechRenderer, s: CallScript): Promise<Int16Array> {
  const parts: Int16Array[] = [];
  for (const g of s.segments) parts.push("say" in g ? await tts.renderPcm(g.say, s.style) : silence(g.pauseMs));
  return concatPcm(parts);
}
