import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(path, out);
    } else if (entry.name.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

test("src/**/*.tsx 不得出现 dangerouslySetInnerHTML", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, index) => {
      if (line.includes("dangerouslySetInnerHTML")) {
        offenders.push(`${file.slice(ROOT.length).replace(/\\/g, "/")}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
