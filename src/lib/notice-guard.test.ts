/**
 * 「续不上」只有一个面孔（docs/desktop-ux.md §8）。
 *
 * 这条守卫盯的是一次真实回归：d0e5569（E13.7）在发送路径里往消息流写了一枚「续不上：…」药丸，
 * 随后 4656984 落地了居中错误态，却没人回头删那枚药丸 —— 同一件事两个面孔，
 * 其中一个还会落库、重开会话后仍留在历史里。
 *
 * 判据：会话连不上 / 续不上是「这次打开的结果」，由 ConnectErrorState 与状态栏表达，**不落库**；
 * 消息流里只允许出现「这一条没发出去」这类**这一轮的真实失败**。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      // 测试文件本身会引用这个模式，不参与扫描
      out.push(full);
    }
  }
  return out;
}

test("消息流里不许再写「续不上」的药丸", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    // 一次调用到分号为止；跨几行的调用也能覆盖，但不会串到下一个语句
    const hit = /pushSystemNotice\s*\([^;]{0,400}?续不上/s.exec(text);
    if (hit) {
      const line = text.slice(0, hit.index).split("\n").length;
      offenders.push(`${file.slice(ROOT.length).replace(/\\/g, "/")}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些地方的 pushSystemNotice 又写了「续不上」，它会落库并留在消息流里：${offenders.join(", ")}`,
  );
});
