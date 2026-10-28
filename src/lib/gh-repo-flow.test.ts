import assert from "node:assert/strict";
import test from "node:test";

import type { GhPhase, GhRepoApi } from "./gh-repo-flow.ts";
import { isBusyPhase, isSettledPhase, runGhRepoFlow } from "./gh-repo-flow.ts";
import type { GhStatusDto } from "./ipc/types.gen/GhStatusDto.ts";
import type { PrDto } from "./ipc/types.gen/PrDto.ts";
import type { RepoRefDto } from "./ipc/types.gen/RepoRefDto.ts";

const ready: GhStatusDto = {
  available: true,
  version: "2.103.3",
  loggedIn: true,
  ghPath: "C:\\Program Files\\GitHub CLI\\gh.exe",
  host: "github.com",
  cwdOk: true,
};

const identity: RepoRefDto = { host: "github.com", owner: "wangsyiiz", name: "SinceArc" };

const pr: PrDto = {
  number: 12,
  title: "E9.4",
  url: "https://github.com/wangsyiiz/SinceArc/pull/12",
  state: "open",
  author: { login: "wangsyiiz", isBot: false },
  head: "feat/e9.4-repo-view",
  base: "feat/e9",
  updatedAt: "2026-10-28T10:00:00Z",
  checks: "passing",
};

type Calls = { status: number; resolve: number; list: number };

interface ApiOptions {
  /** 覆盖 status 的返回（仍然计数）。 */
  status?: (force: boolean) => Promise<GhStatusDto>;
  resolve?: (path: string) => Promise<RepoRefDto>;
  list?: (force: boolean) => Promise<{ items: PrDto[] }>;
}

function api(overrides: ApiOptions = {}) {
  const calls: Calls = { status: 0, resolve: 0, list: 0 };
  const impl: GhRepoApi = {
    status: async (force) => {
      calls.status += 1;
      return overrides.status ? overrides.status(force) : ready;
    },
    resolve: async (path) => {
      calls.resolve += 1;
      return overrides.resolve ? overrides.resolve(path) : identity;
    },
    list: async (_repo, _state, force) => {
      calls.list += 1;
      return overrides.list ? overrides.list(force) : { items: [pr] };
    },
  };
  return { calls, impl };
}

function track(onPhase: (phase: GhPhase) => void) {
  const seen: GhPhase["kind"][] = [];
  return {
    seen,
    record: (phase: GhPhase) => {
      seen.push(phase.kind);
      onPhase(phase);
    },
  };
}

test("三步顺序：checking → resolving → loading → ready", async () => {
  const { calls, impl } = api();
  let last: GhPhase | undefined;
  const { seen, record } = track((phase) => {
    last = phase;
  });

  const result = await runGhRepoFlow(impl, "C:\\source\\sincearc", false, record);

  assert.deepEqual(seen, ["checking", "resolving", "loading", "ready"]);
  assert.equal(result.kind, "ready");
  assert.deepEqual(calls, { status: 1, resolve: 1, list: 1 });
  assert.equal(last?.kind, "ready");
  if (last?.kind === "ready") {
    assert.deepEqual(last.identity, identity);
    assert.deepEqual(last.prs, [pr]);
  }
});

test("未安装：停在 unavailable，不再调 resolve / list", async () => {
  const { calls, impl } = api({
    status: async () => ({
      ...ready,
      available: false,
      version: null,
      ghPath: null,
      loggedIn: false,
    }),
  });
  const { seen, record } = track(() => {});

  const result = await runGhRepoFlow(impl, "C:\\x", false, record);

  assert.deepEqual(seen, ["checking", "unavailable"]);
  assert.equal(result.kind, "unavailable");
  assert.deepEqual(calls, { status: 1, resolve: 0, list: 0 });
});

test("未登录：也只停在 unavailable（只显示登录那一步）", async () => {
  const { calls, impl } = api({ status: async () => ({ ...ready, loggedIn: false }) });
  const { seen, record } = track(() => {});

  const result = await runGhRepoFlow(impl, "C:\\x", false, record);

  assert.deepEqual(seen, ["checking", "unavailable"]);
  assert.equal(result.kind, "unavailable");
  assert.deepEqual(calls, { status: 1, resolve: 0, list: 0 });
  if (result.kind === "unavailable") assert.equal(result.status.loggedIn, false);
});

test("50717 → resolveFailed（与空列表分得开），不调 list", async () => {
  const { calls, impl } = api({
    resolve: async () => {
      throw { code: 50717, msg: "no remote", key: "err.gh.noRemote", params: { path: "C:\\x" } };
    },
  });
  const { seen, record } = track(() => {});

  const result = await runGhRepoFlow(impl, "C:\\x", false, record);

  assert.deepEqual(seen, ["checking", "resolving", "resolveFailed"]);
  assert.equal(result.kind, "resolveFailed");
  assert.deepEqual(calls, { status: 1, resolve: 1, list: 0 });
  if (result.kind === "resolveFailed") {
    assert.equal(result.error.code, 50717);
    assert.equal(result.error.key, "err.gh.noRemote");
  }
});

test("身份解析的非 50717 错误走通用 failed", async () => {
  const { impl } = api({
    resolve: async () => {
      throw { code: 50000, msg: "path required" };
    },
  });
  const { seen, record } = track(() => {});

  const result = await runGhRepoFlow(impl, "", false, record);

  assert.deepEqual(seen, ["checking", "resolving", "failed"]);
  assert.equal(result.kind, "failed");
});

test("列表为空仍是 ready（= 这个仓库没有 PR），不是失败", async () => {
  const { impl } = api({ list: async () => ({ items: [] }) });
  const { seen, record } = track(() => {});

  const result = await runGhRepoFlow(impl, "C:\\x", false, record);

  assert.deepEqual(seen, ["checking", "resolving", "loading", "ready"]);
  assert.equal(result.kind, "ready");
  if (result.kind === "ready") assert.deepEqual(result.prs, []);
});

test("列表错误（50713）落到 failed，保住码", async () => {
  const { impl } = api({
    list: async () => {
      throw { code: 50713, msg: "repo missing" };
    },
  });
  const { seen, record } = track(() => {});

  const result = await runGhRepoFlow(impl, "C:\\x", false, record);

  assert.deepEqual(seen, ["checking", "resolving", "loading", "failed"]);
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.error.code, 50713);
});

test("PR 不存在（50716）也落到 failed —— 详情页据此显示人话", async () => {
  const { impl } = api({
    list: async () => {
      throw { code: 50716, msg: "pr 999", key: "err.gh.prNotFound", params: { detail: "pr 999" } };
    },
  });
  const result = await runGhRepoFlow(impl, "C:\\x", false, () => {});
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.equal(result.error.code, 50716);
    assert.equal(result.error.key, "err.gh.prNotFound");
  }
});

test("status 抛错（例如不在 Tauri 里）落到 failed", async () => {
  const { impl } = api({
    status: async () => {
      throw { code: 50900, msg: "not tauri" };
    },
  });
  const { seen, record } = track(() => {});

  const result = await runGhRepoFlow(impl, "C:\\x", false, record);

  assert.deepEqual(seen, ["checking", "failed"]);
  assert.equal(result.kind, "failed");
});

test("force 透传给 status（重新检测绕缓存）", async () => {
  const forces: boolean[] = [];
  const impl: GhRepoApi = {
    status: async (force) => {
      forces.push(force);
      return ready;
    },
    resolve: async () => identity,
    list: async (_repo, _state, force) => {
      forces.push(force);
      return { items: [] };
    },
  };

  await runGhRepoFlow(impl, "C:\\x", true, () => {});

  assert.deepEqual(forces, [true, true]);
});

test("phase 分类：只有有结论的 phase 算 settled，推进中算 busy", () => {
  assert.equal(isSettledPhase(undefined), false);
  assert.equal(isSettledPhase({ kind: "idle" }), false);
  assert.equal(isSettledPhase({ kind: "checking" }), false);
  assert.equal(isSettledPhase({ kind: "resolving" }), false);
  assert.equal(isSettledPhase({ kind: "loading" }), false);
  assert.equal(isSettledPhase({ kind: "ready", identity, prs: [] }), true);
  assert.equal(isSettledPhase({ kind: "unavailable", status: ready }), true);
  assert.equal(isSettledPhase({ kind: "resolveFailed", error: { code: 50717, msg: "x" } }), true);
  assert.equal(isSettledPhase({ kind: "failed", error: { code: 50713, msg: "x" } }), true);

  for (const kind of ["checking", "resolving", "loading"] as const) {
    assert.equal(isBusyPhase({ kind }), true);
  }
  assert.equal(isBusyPhase({ kind: "idle" }), false);
  assert.equal(isBusyPhase({ kind: "ready", identity, prs: [] }), false);
});

test("非 Error/Loose 的 throw 也归一成 CmdError", async () => {
  const { impl } = api({
    status: async () => {
      throw "boom";
    },
  });
  const result = await runGhRepoFlow(impl, "C:\\x", false, () => {});
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.equal(result.error.code, 50000);
    assert.equal(result.error.msg, "boom");
  }
});
