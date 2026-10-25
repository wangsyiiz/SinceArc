import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const CALL = /\b(?:messagesAppend|appendMessages)\s*\(/;
const DECLARATION = /(?:export\s+)?function\s+(?:messagesAppend|appendMessages)\s*\(/;
const WINDOW_LINES = 31;

/**
 * 显式白名单：只有确实无法在调用点表态、且原因可复核的文件才允许列在这里。
 * 不要按目录放宽。
 */
const WHITELIST: { file: string; reason: string }[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    if (!entry.isFile()) return [];
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

function rel(path: string): string {
  return relative(ROOT, path).split(sep).join("/");
}

function violates(text: string): boolean {
  const hasTurnId =
    /\bturnId\s*:\s*(?!null\b|undefined\b)/.test(text) || /\{\s*turnId\s*\}/.test(text);
  const hasNonTurn = /\bnonTurn\s*:\s*true\b/.test(text);
  return !hasTurnId && !hasNonTurn;
}

test("每个 messagesAppend 调用点都显式表态：turnId 或 nonTurn: true", () => {
  const allowed = new Set(WHITELIST.map((entry) => entry.file));
  const violations: string[] = [];

  for (const file of walk(SRC)) {
    const filePath = rel(file);
    if (allowed.has(filePath)) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);

    lines.forEach((line, index) => {
      if (!CALL.test(line) || DECLARATION.test(line)) return;
      const window = lines.slice(index, index + WINDOW_LINES).join("\n");
      if (violates(window)) violations.push(`${filePath}:${index + 1}`);
    });
  }

  assert.deepEqual(
    violations,
    [],
    [
      "messagesAppend 调用点必须显式表态：传非空 turnId，或写 nonTurn: true。",
      ...violations,
    ].join("\n"),
  );
});
