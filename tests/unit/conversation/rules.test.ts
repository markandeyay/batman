import { describe, expect, it } from "vitest";
import {
  hasDistressLexicon,
  isExplicitDistress,
  isGo,
  matchKeywordRule,
  parseExtend,
  parseMoving,
  weakReplyLabel,
} from "../../../apps/server/src/nlu/rules.js";

describe("deterministic keyword rules (8.4 step 8, 4.6)", () => {
  it.each([
    ["STOP", "stop"],
    ["help", "help"],
    ["I don't feel safe", "distress"],
    ["come get me", "distress"],
    ["he won't let me leave", "distress"],
    ["help me", "distress"],
    ["+30", "extend"],
    ["add 30 min", "extend"],
    ["going to be longer", "extend"],
    ["we're getting dinner after", "extend"],
    ["home", "home"],
    ["made it home", "home"],
    ["im home!", "home"],
    ["done", "done"],
    ["leaving", "done"],
    ["heading home", "done"],
    ["all good im out", "done"],
    ["cancel", "cancel"],
    ["not going", "cancel"],
    ["he cancelled", "cancel"],
    ["status", "status"],
    ["change backup", "change_backup"],
    ["change code words", "change_codewords"],
    ["change caller", "change_caller"],
    ["delete my data", "delete_data"],
    ["we're moving to the bar next door", "moving"],
  ])("%s -> %s", (text, kind) => {
    expect(matchKeywordRule(text)?.kind).toBe(kind);
  });

  it.each(["hey", "yeah lol", "the movie was ok", "im not scared lol", "i dont need help", "no need to come get me"])("%s matches no command or distress", (t) => {
    const r = matchKeywordRule(t);
    expect(r === null || (r.kind !== "distress" && r.kind !== "help")).toBe(true);
  });

  it("parses extension minutes", () => {
    expect(parseExtend("+30")).toBe(30);
    expect(parseExtend("+1h")).toBe(60);
    expect(parseExtend("another hour")).toBe(60);
    expect(parseExtend("45 more minutes")).toBe(45);
    expect(parseExtend("add 2 hours")).toBe(120);
    expect(parseExtend("going to be a bit longer")).toBe(30);
    expect(parseExtend("we are fine")).toBeNull();
  });

  it("parses moving targets", () => {
    expect(parseMoving("we're moving to the bar next door")).toBe("the bar next door");
    expect(parseMoving("Moving to Lazy Bird.")).toBe("Lazy Bird");
    expect(parseMoving("going to be longer")).toBeNull();
  });

  it("explicit distress vs lexicon", () => {
    expect(isExplicitDistress("no come get me")).toBe(true);
    expect(isExplicitDistress("he's not following me, all good")).toBe(false);
    expect(hasDistressLexicon("idk this is getting weird")).toBe(true);
    expect(hasDistressLexicon("no")).toBe(true);
    expect(hasDistressLexicon("no worries")).toBe(false);
    expect(hasDistressLexicon("yeah good")).toBe(false);
  });

  it("weak reply label (model fallback)", () => {
    expect(weakReplyLabel("im good")).toBe("OK");
    expect(weakReplyLabel("yeah lol")).toBe("OK");
    expect(weakReplyLabel("👍")).toBe("OK");
    expect(weakReplyLabel("not really")).toBe("NOT_OK");
    expect(weakReplyLabel("who is this")).toBeNull();
  });

  it("GO detection", () => {
    for (const t of ["go", "GO!", "lock it in", "yes", "👍"]) expect(isGo(t)).toBe(true);
    for (const t of ["actually 8pm", "no", "wait"]) expect(isGo(t)).toBe(false);
  });
});
