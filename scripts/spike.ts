// pnpm spike <name> [args...] : runs scripts/spike-<name>.ts (spec Section 14 Phase 0b).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [name, ...rest] = process.argv.slice(2);
const dir = import.meta.dirname;
const available = fs
  .readdirSync(dir)
  .filter((f) => /^spike-.+\.ts$/.test(f))
  .map((f) => f.slice("spike-".length, -".ts".length));

if (!name || !available.includes(name)) {
  console.log(`usage: pnpm spike <name> [args]\navailable: ${available.join(", ") || "(none)"}`);
  process.exit(name ? 1 : 0);
}
const r = spawnSync(process.execPath, ["--import", "tsx", path.join(dir, `spike-${name}.ts`), ...rest], { stdio: "inherit" });
process.exit(r.status ?? 1);
