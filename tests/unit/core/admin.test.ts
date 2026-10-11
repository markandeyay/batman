import { describe, expect, it } from "vitest";
import { parseAdminCommand, parseAdminNumbers, type AdminConfig } from "../../../apps/server/src/admin/commands.js";

const ADMIN = "+13125550100";
const demo: AdminConfig = { adminNumbers: [ADMIN], demoMode: true, testMode: false };
const prod: AdminConfig = { adminNumbers: [ADMIN], demoMode: false, testMode: false };

describe("admin commands (15.4)", () => {
  it("parses ADMIN_NUMBERS", () => {
    expect(parseAdminNumbers(" +13125550100, +19195550142 ,bad,")).toEqual(["+13125550100", "+19195550142"]);
    expect(parseAdminNumbers(undefined)).toEqual([]);
  });

  it("ignores non-slash texts", () => {
    expect(parseAdminCommand("hey there", ADMIN, demo)).toBeNull();
    expect(parseAdminCommand("+30", ADMIN, demo)).toBeNull();
  });

  it("non-admins never run commands", () => {
    expect(parseAdminCommand("/ff 30", "+19195550142", demo)).toEqual({ kind: "not_admin" });
    expect(parseAdminCommand("/status", "+19195550142", demo)).toEqual({ kind: "not_admin" });
  });

  it("/ff <minutes> only in demo or test mode", () => {
    expect(parseAdminCommand("/ff 30", ADMIN, demo)).toEqual({ kind: "ff", minutes: 30 });
    expect(parseAdminCommand("/FF  15 ", ADMIN, { ...prod, testMode: true })).toEqual({ kind: "ff", minutes: 15 });
    expect(parseAdminCommand("/ff 30", ADMIN, prod)).toEqual({ kind: "denied", command: "ff", reason: "ff_requires_demo_or_test_mode" });
  });

  it("/ff validates the argument", () => {
    for (const bad of ["/ff", "/ff -5", "/ff 0", "/ff 2.5", "/ff ten", "/ff 1441"]) {
      expect(parseAdminCommand(bad, ADMIN, demo)?.kind, bad).toBe("invalid");
    }
  });

  it("/status and /users", () => {
    expect(parseAdminCommand("/status", ADMIN, prod)).toEqual({ kind: "status" });
    expect(parseAdminCommand("/users", ADMIN, prod)).toEqual({ kind: "users" });
    expect(parseAdminCommand("/users all", ADMIN, prod)?.kind).toBe("invalid");
    expect(parseAdminCommand("/reboot", ADMIN, prod)).toEqual({ kind: "unknown", command: "reboot" });
  });
});
