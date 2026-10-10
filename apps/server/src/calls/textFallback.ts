// TextFallbackCallService: used when voice calls are not configured or Spike S2 fails (spec 10.4).
// place() always resolves false, so the executor takes the text path (exit: "Call me asap" plus
// notifySilenced; L2: L2 text plus notifySilenced; guardian alert: text only).
// No spectrum-ts imports.
import type { CallService, DecoyCaller, E164 } from "../contracts.js";

export class TextFallbackCallService implements CallService {
  async place(_to: E164, _script: "fake" | "checkin" | "guardian_alert", _ctx: { decoy: DecoyCaller; userName: string }): Promise<boolean> {
    return false;
  }
}
