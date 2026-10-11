// Phone number helpers (spec 4.2, 8.1). Default region US. Never log full numbers: use redactPhone.
import { parsePhoneNumberFromString, findPhoneNumbersInText, type CountryCode } from "libphonenumber-js";
import type { E164 } from "../contracts.js";

export const DEFAULT_REGION: CountryCode = "US";

export type PhoneParse = { ok: true; e164: E164 } | { ok: false; reason: "invalid" | "ambiguous" };

/**
 * Normalize a user-typed number to E.164. Accepts "+1 919 555 0142", "(919) 555-0142",
 * "919.555.0142", "19195550142". Numbers without a country code are read in `region`.
 * A number that is possible but not valid is reported as "ambiguous" so the dialogue can ask
 * the user to double check it.
 */
export function parsePhone(input: string, region: CountryCode = DEFAULT_REGION): PhoneParse {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return { ok: false, reason: "invalid" };
  const pn = parsePhoneNumberFromString(raw, region);
  if (!pn) return { ok: false, reason: "invalid" };
  if (pn.isValid()) return { ok: true, e164: pn.number as E164 };
  // Fictional US 555-01XX numbers are "possible" but not "valid" in the metadata. Accept possible
  // NANP numbers; Photon is the final judge of deliverability.
  if (pn.isPossible() && pn.countryCallingCode === "1") return { ok: true, e164: pn.number as E164 };
  return { ok: false, reason: pn.isPossible() ? "ambiguous" : "invalid" };
}

export function normalizePhone(input: string, region: CountryCode = DEFAULT_REGION): E164 | null {
  const r = parsePhone(input, region);
  return r.ok ? r.e164 : null;
}

export interface PhoneInText {
  e164: E164;
  /** Offsets of the number in the source text. */
  start: number;
  end: number;
}

/** Find phone numbers inside free text ("Priya 919 555 0142"). */
export function findPhonesInText(text: string, region: CountryCode = DEFAULT_REGION): PhoneInText[] {
  const out: PhoneInText[] = [];
  for (const f of findPhoneNumbersInText(text, region)) {
    out.push({ e164: f.number.number as E164, start: f.startsAt, end: f.endsAt });
  }
  if (out.length > 0) return out;
  // Fallback for loosely formatted digits the strict finder skips (e.g. fictional 555 numbers).
  for (const m of text.matchAll(/\+?\d[\d\s().-]{5,}\d/g)) {
    const e = normalizePhone(m[0], region);
    if (e) out.push({ e164: e, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function isSameNumber(a: string, b: string): boolean {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  return x !== null && x === y;
}

/** Human-friendly format: "+16285550100" -> "(628) 555-0100"; international numbers keep the "+". */
export function formatPhoneForDisplay(e164: string): string {
  const pn = parsePhoneNumberFromString(e164);
  if (!pn) return e164;
  return pn.countryCallingCode === "1" ? pn.formatNational() : pn.formatInternational();
}

/** Redact to the last 4 digits for logs (spec 8.1): "+19195550142" -> "***0142". */
export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return "***";
  return "***" + phone.replace(/\D/g, "").slice(-4);
}
