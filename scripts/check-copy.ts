// Fails if any tracked or new source, doc, or data file contains an em dash (CLAUDE.md non-negotiable).
// The spec itself is excluded (it is the human's document).
import { execSync } from "node:child_process";
import fs from "node:fs";

const EM = String.fromCharCode(0x2014);
const files = execSync("git ls-files -co --exclude-standard", { encoding: "utf8" })
  .split(/\r?\n/)
  .filter((f) => /\.(ts|tsx|js|mjs|md|json|jsonl|txt|yaml|yml)$/.test(f))
  .filter((f) => f !== "docs/BATMAN_SPEC.md" && f !== "pnpm-lock.yaml" && !f.includes("node_modules"));

let bad = 0;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  fs.readFileSync(f, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (line.includes(EM)) {
        bad++;
        console.log(`${f}:${i + 1}: em dash`);
      }
    });
}
if (bad) {
  console.log(`check-copy: ${bad} em dash(es) found`);
  process.exit(1);
}
console.log(`check-copy: ok (${files.length} files)`);
