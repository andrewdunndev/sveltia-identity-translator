import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";

const lint = (name) =>
  spawnSync(process.execPath, ["scripts/lint-editors.mjs", `test/fixtures/${name}.yml`], { encoding: "utf8" });

describe("lint-editors", () => {
  test("a valid policy passes", () => {
    assert.equal(lint("valid").status, 0);
  });
  test("a root allowing active-content extensions fails", () => {
    const r = lint("svg");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /svg/);
  });
  test("a '**' grant escaping the roots fails", () => {
    const r = lint("human-root");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /escapes/);
  });
});
