// Terminal provider wiring for `pnpm chat` (spec 16.2, 11.2; PHOTON_NOTES mismatch 13).
//
// terminal.config() only accepts `commands`; the console sender id is assigned by the tuichat
// child process. So Batman maps that id itself: the console types as the configured test user
// by default, `/as guardian` and `/as user` switch identity. Outbound messages to either test
// address go back to the console space, prefixed with the recipient so both sides are visible.
// Calls are stubbed and printed as [CALL -> user: <script>]. Run with LOCATION_SOURCE=replay.
//
// Default test addresses are fictional 555-01XX numbers, never a real phone, so a routing bug
// can not text a real person from the console.
import { callScript, spokenText } from "../calls/scripts.js";
import type { CallService, DecoyCaller, E164 } from "../contracts.js";
import type { SpaceHandle, SpaceResolver } from "./channel.js";
import type { RawMessage } from "./normalize.js";
import { toSpaceHandle } from "./spectrum.js";
import type { Space } from "spectrum-ts";

export const TERMINAL_USER_DEFAULT = "+15555550100" as E164;
export const TERMINAL_GUARDIAN_DEFAULT = "+15555550101" as E164;

export const TERMINAL_COMMANDS = [
  { name: "/as", description: "/as guardian or /as user: switch who is typing" },
];

export type TerminalIdentity = "user" | "guardian";

export interface TerminalBridgeOptions {
  userAddress?: E164;
  guardianAddress?: E164;
  /** Fallback printer when no console space is known yet. Default console.log (hijacked into the TUI). */
  print?: (line: string) => void;
}

const AS_RE = /^\s*\/as\s+(guardian|user)\s*$/i;

export class TerminalBridge implements SpaceResolver {
  readonly userAddress: E164;
  readonly guardianAddress: E164;
  private identity: TerminalIdentity = "user";
  private space: SpaceHandle | null = null;
  private readonly print: (line: string) => void;

  constructor(o: TerminalBridgeOptions = {}) {
    this.userAddress = o.userAddress ?? TERMINAL_USER_DEFAULT;
    this.guardianAddress = o.guardianAddress ?? TERMINAL_GUARDIAN_DEFAULT;
    this.print = o.print ?? ((l) => console.log(l));
  }

  get current(): TerminalIdentity {
    return this.identity;
  }

  /** True for the addresses the console stands in for. */
  handles(to: E164): boolean {
    return to === this.userAddress || to === this.guardianAddress;
  }

  /** Remember the console space (any terminal message). */
  rememberSpace(space: unknown): void {
    if (space && typeof (space as Space).send === "function") this.space = toSpaceHandle(space as Space, "terminal");
  }

  /** Test hook: use a prepared handle. */
  setSpace(handle: SpaceHandle): void {
    this.space = handle;
  }

  /** Consume `/as ...` commands. Returns true when the message was a command. */
  async intercept(m: RawMessage, space: unknown): Promise<boolean> {
    if (m.platform !== "terminal") return false;
    this.rememberSpace(space);
    if (m.content.type !== "text") return false;
    const match = AS_RE.exec(String(m.content.text ?? ""));
    if (!match) return false;
    this.identity = match[1]!.toLowerCase() as TerminalIdentity;
    await this.say(`[now typing as ${this.identity}]`);
    return true;
  }

  /** Terminal sender -> the configured E.164 for the current identity. */
  resolveFrom(m: RawMessage): E164 | null {
    if (m.platform !== "terminal") return null;
    return this.identity === "guardian" ? this.guardianAddress : this.userAddress;
  }

  async resolve(to: E164): Promise<SpaceHandle> {
    if (!this.handles(to)) throw new Error("terminal: not a console address");
    const label = to === this.guardianAddress ? "guardian" : "user";
    return {
      id: `terminal:${label}`,
      kind: "terminal",
      send: async (text: string) => {
        const s = this.space;
        if (!s) {
          this.print(`[to ${label}] ${text}`);
          return { id: `terminal-${Date.now()}`, timestamp: new Date() };
        }
        return s.send(`[to ${label}] ${text}`);
      },
      responding: <T>(fn: () => Promise<T>) => (this.space ? this.space.responding(fn) : fn()),
    };
  }

  async say(line: string): Promise<void> {
    if (this.space) await this.space.send(line);
    else this.print(line);
  }
}

/** Stubbed calls for the console: printed, always "placed". */
export class TerminalCallService implements CallService {
  constructor(private readonly bridge: TerminalBridge) {}

  async place(to: E164, script: "fake" | "checkin" | "guardian_alert", ctx: { decoy: DecoyCaller; userName: string }): Promise<boolean> {
    const who = to === this.bridge.guardianAddress ? "guardian" : "user";
    await this.bridge.say(`[CALL -> ${who}: ${script} call script] ${spokenText(callScript(script, ctx))}`);
    return true;
  }
}
