// Creates (or reuses) Batman's LiveKit outbound SIP trunk to Photon Spectrum Voice (spec 10.2)
// and writes its id to .env as LIVEKIT_SIP_TRUNK_ID. Never prints secrets.
// Leaves every other trunk in the LiveKit project untouched.
// Usage: npx tsx scripts/livekit-setup.ts
import fs from "node:fs";
import path from "node:path";
import { SipClient } from "livekit-server-sdk";
import { ListUpdate, SIPTransport } from "@livekit/protocol";

const root = path.resolve(import.meta.dirname, "..");

const envPath = path.join(root, ".env");
const raw = fs.readFileSync(envPath, "utf8");
const env: Record<string, string> = {};
for (const l of raw.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.trim();
}
for (const k of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET", "BATMAN_LINE_E164"]) {
  if (!env[k]) throw new Error(`missing ${k} in .env`);
}

const TRUNK_NAME = "batman-photon";
const host = env.LIVEKIT_URL!.replace(/^wss:/, "https:");
const sip = new SipClient(host, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

const existing = (await sip.listSipOutboundTrunk()).find((t) => t.name === TRUNK_NAME);
let trunkId: string;
if (existing) {
  trunkId = existing.sipTrunkId;
  // address and transport are not updatable through the API; only warn if they drifted.
  if (existing.address !== "sip.spectrum.photon.codes:5061" || existing.transport !== SIPTransport.SIP_TRANSPORT_TLS) {
    console.log("warning: trunk address or transport differs from spec 10.2; recreate it in the LiveKit dashboard if calls fail");
  }
  await sip.updateSipOutboundTrunkFields(trunkId, {
    numbers: new ListUpdate({ set: [env.BATMAN_LINE_E164!] }),
    authUsername: env.SPECTRUM_PROJECT_ID!,
    authPassword: env.SPECTRUM_PROJECT_SECRET!,
  });
  console.log(`updated existing trunk ${trunkId} (${TRUNK_NAME})`);
} else {
  const t = await sip.createSipOutboundTrunk(TRUNK_NAME, "sip.spectrum.photon.codes:5061", [env.BATMAN_LINE_E164!], {
    transport: SIPTransport.SIP_TRANSPORT_TLS,
    authUsername: env.SPECTRUM_PROJECT_ID!,
    authPassword: env.SPECTRUM_PROJECT_SECRET!,
    metadata: "Batman: outbound calls via Photon Spectrum Voice (spec 10.2)",
  });
  trunkId = t.sipTrunkId;
  console.log(`created trunk ${trunkId} (${TRUNK_NAME})`);
}

const prior = env.LIVEKIT_SIP_TRUNK_ID;
let out = raw;
const setVar = (k: string, v: string) => {
  const re = new RegExp(`^${k}=.*$`, "m");
  out = re.test(out) ? out.replace(re, `${k}=${v}`) : out.replace(/\n?$/, "\n") + `${k}=${v}\n`;
};
setVar("LIVEKIT_SIP_TRUNK_ID", trunkId);
fs.writeFileSync(envPath, out);
console.log(`LIVEKIT_SIP_TRUNK_ID set to ${trunkId}${prior && prior !== trunkId ? ` (previous value ${prior} left untouched in LiveKit)` : ""}`);
