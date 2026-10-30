import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRepoRows,
  repoCloneCommand,
  sortRepoRows,
  type RepoPickerRow,
} from "./repos-picker.ts";
import type { GhRepoListingDto } from "./ipc/types.gen/GhRepoListingDto.ts";
import type { RepoDto } from "./ipc/types.gen/RepoDto.ts";

function repo(overrides: Partial<RepoDto> & Pick<RepoDto, "owner" | "name">): RepoDto {
  return {
    id: `repo-${overrides.owner}-${overrides.name}`,
    host: "github.com",
    defaultBranch: "main",
    pinned: false,
    lastUsedAt: null,
    locals: [],
    ...overrides,
  };
}

function listing(
  overrides: Partial<GhRepoListingDto> & Pick<GhRepoListingDto, "owner" | "name">,
): GhRepoListingDto {
  return {
    host: "github.com",
    defaultBranch: "main",
    isPrivate: false,
    updatedAt: null,
    description: null,
    ...overrides,
  };
}

function row(overrides: Partial<RepoPickerRow> & Pick<RepoPickerRow, "owner" | "name">): RepoPickerRow {
  return {
    host: "github.com",
    state: "browseOnly",
    pinned: false,
    lastUsedAt: null,
    source: "local",
    ...overrides,
  };
}

test("库里命中且有副本：hasLocal，并带上第一个副本路径", () => {
  const rows = buildRepoRows(
    [
      repo({
        owner: "acme",
        name: "api",
        pinned: true,
        lastUsedAt: 42,
        locals: [
          { id: "l1", path: "/work/api", hostKind: "local" },
          { id: "l2", path: "/other/api", hostKind: "local" },
        ],
      }),
    ],
    [listing({ owner: "acme", name: "api", isPrivate: true })],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "hasLocal");
  assert.equal(rows[0].localPath, "/work/api");
  assert.equal(rows[0].pinned, true);
  assert.equal(rows[0].lastUsedAt, 42);
  assert.equal(rows[0].isPrivate, true);
  assert.equal(rows[0].source, "gh");
});

test("库里命中但无副本：browseOnly", () => {
  const rows = buildRepoRows([repo({ owner: "acme", name: "web" })], [listing({ owner: "acme", name: "web" })]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "browseOnly");
  assert.equal(rows[0].localPath, undefined);
  assert.equal(rows[0].source, "gh");
});

test("只有 gh 列表里有：needsClone", () => {
  const rows = buildRepoRows([], [listing({ owner: "acme", name: "new", defaultBranch: "trunk" })]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "needsClone");
  assert.equal(rows[0].pinned, false);
  assert.equal(rows[0].lastUsedAt, null);
  assert.equal(rows[0].defaultBranch, "trunk");
  assert.equal(rows[0].source, "gh");
});

test("只有库里有副本：hasLocal，source=local", () => {
  const rows = buildRepoRows(
    [repo({ owner: "acme", name: "local", locals: [{ id: "l1", path: "C:\\src\\local", hostKind: "local" }] })],
    [],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "hasLocal");
  assert.equal(rows[0].localPath, "C:\\src\\local");
  assert.equal(rows[0].source, "local");
});

test("GH 不可用（空列表）时库里的无副本项目仍可见：browseOnly，source=local", () => {
  const rows = buildRepoRows([repo({ owner: "acme", name: "remote-only" })], []);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "browseOnly");
  assert.equal(rows[0].source, "local");
});

test("同一身份只出现一行：库与 gh 列表合并不重复", () => {
  const rows = buildRepoRows(
    [repo({ owner: "acme", name: "dup" })],
    [listing({ owner: "acme", name: "dup" }), listing({ owner: "acme", name: "dup" })],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "dup");
});

test("空列表返回空数组", () => {
  assert.deepEqual(buildRepoRows([], []), []);
});

test("排序：pin 区优先，然后最近使用降序，null 最后，其它按 name 升序", () => {
  const sorted = sortRepoRows([
    row({ owner: "a", name: "z-old", lastUsedAt: 10 }),
    row({ owner: "a", name: "a-never" }),
    row({ owner: "a", name: "m-pinned", pinned: true, lastUsedAt: null }),
    row({ owner: "a", name: "b-recent", lastUsedAt: 99 }),
  ]);

  assert.deepEqual(
    sorted.map((item) => item.name),
    ["m-pinned", "b-recent", "z-old", "a-never"],
  );
});

test("排序：同样没有 lastUsedAt 时按 name 升序", () => {
  const sorted = sortRepoRows([
    row({ owner: "a", name: "zeta" }),
    row({ owner: "a", name: "alpha" }),
    row({ owner: "a", name: "beta" }),
  ]);

  assert.deepEqual(
    sorted.map((item) => item.name),
    ["alpha", "beta", "zeta"],
  );
});

test("排序不修改输入数组", () => {
  const input = [
    row({ owner: "a", name: "b", lastUsedAt: 1 }),
    row({ owner: "a", name: "a", lastUsedAt: 2 }),
  ];
  const before = input.map((item) => item.name);

  const sorted = sortRepoRows(input);

  assert.deepEqual(input.map((item) => item.name), before);
  assert.deepEqual(sorted.map((item) => item.name), ["a", "b"]);
});

test("合流时 host 大小写不同仍按同一身份合并", () => {
  const rows = buildRepoRows(
    [repo({ host: "GitHub.com", owner: "acme", name: "case" })],
    [listing({ host: "github.com", owner: "acme", name: "case" })],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, "GitHub.com");
});

test("clone 命令：github.com 用 owner/name，其它 host 带上 host", () => {
  assert.equal(
    repoCloneCommand({ host: "github.com", owner: "acme", name: "api" }),
    "gh repo clone acme/api",
  );
  assert.equal(
    repoCloneCommand({ host: "", owner: "acme", name: "api" }),
    "gh repo clone acme/api",
  );
  assert.equal(
    repoCloneCommand({ host: "ghe.example.com", owner: "acme", name: "api" }),
    "gh repo clone ghe.example.com/acme/api",
  );
});
