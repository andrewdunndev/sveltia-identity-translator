import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../scripts/sveltia-contract.mjs", import.meta.url));
const B = "`";

// A package dir holding `chunk` as dist/chunks/gitlab.js (null: no chunk).
function check(chunk) {
  const dir = mkdtempSync(join(tmpdir(), "sveltia-contract-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@sveltia/cms", version: "0.0.0-test" }));
    if (chunk !== null) {
      mkdirSync(join(dir, "dist", "chunks"), { recursive: true });
      writeFileSync(join(dir, "dist", "chunks", "gitlab.js"), chunk);
    }
    const r = spawnSync(process.execPath, [CLI, dir], { encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const gql = (doc) => `${B}\n  ${doc}\n${B}`;
// Minified the way Sveltia ships: a regex holding a quote, a
// conditional both in the variables and the arguments, REST paths
// with methods and an inlined URLSearchParams.
const READS = [
  `var Gt=e=>e?.split(${B},${B}).find(e=>/;\\s*rel="next"/.test(e));`,
  `var It=({scoped:e})=>${gql(`query($fullPath: ID!, $ref: String!\${e?${B}, $path: String!${B}:${B}${B}}) { project(fullPath: $fullPath) { repository { tree(ref: $ref\${e?${B}, path: $path${B}:${B}${B}}) { trees { nodes { name sha } } } } } }`)};`,
  `var Ut=${gql("query($fullPath: ID!, $ref: String!) { project(fullPath: $fullPath) { repository { paginatedTree(ref: $ref, first: 100) { nodes { blobs { nodes { path } } } } } } }")};`,
  `var Kt=async(e,t)=>{let i=new URLSearchParams({...e&&{path:e},ref:t,per_page:${B}100${B},pagination:${B}keyset${B}}),a=await w(${B}/projects/\${M()}/repository/tree?\${i}${B},{responseType:${B}raw${B}})};`,
  `var V=async(h,i)=>w(${B}/projects/\${M(i)}/repository/commits${B},{method:${B}POST${B},body:h});`,
].join("\n");

test("a chunk Sveltia could ship today passes", () => {
  const r = check(READS);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /3 graphql documents, 2 rest paths/);
  assert.match(r.out, /0 denied/);
});

test("a denied mutation fails with its at= reason", () => {
  const r = check(`${READS}\nvar Mt=${gql("mutation($fullPath: ID!) { commitCreate(input: { projectPath: $fullPath }) { errors } }")};`);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^denied +mutation\(\$fullPath.*\[graphql mutation\] at=mutation$/m);
});

test("a read that leaves the repository fails", () => {
  const r = check(`${READS}\nvar At=${gql("query($fullPath: ID!) { project(fullPath: $fullPath) { repository { lastCommit { author { username } } } } }")};`);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /at=project\.repository\.lastCommit\.author/);
});

test("merge request queries and routes are reported as excluded, not skipped", () => {
  const r = check(
    `${READS}\nvar Zt=${gql("query($fullPath: ID!, $iids: [String!]) { project(fullPath: $fullPath) { mergeRequests(iids: $iids) { nodes { iid } } } }")};` +
      `\nvar G=e=>${B}/projects/\${M()}/merge_requests/\${e}${B},yn=async e=>w(${B}\${G(e)}/diffs?per_page=\${K}${B});`,
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^excluded .*\[graphql project\.mergeRequests\] editorial workflow$/m);
  assert.match(r.out, /^excluded .*\[rest GET projects\/\{repo\}\/merge_requests\/\{\}\/diffs\]/m);
});

test("an unknown route, or a query parameter the route drops, fails", () => {
  const r = check(
    `${READS}\nvar P=async()=>w(${B}/projects/\${M()}/repository/archive.zip${B});` +
      `\nvar Q=async e=>w(${B}/projects/\${M()}/repository/commits?ref_name=\${e}&since=\${e}${B});`,
  );
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[rest GET projects\/\{repo\}\/repository\/archive\.zip\] at=deny\.route/);
  assert.match(r.out, /\[rest GET projects\/\{repo\}\/repository\/commits\?since\] at=query\(since\) dropped/);
});

test("no chunk, or a chunk with no GraphQL documents or REST paths, fails loudly", () => {
  for (const chunk of [null, "", `var a=${B}/projects/\${M()}/repository/commits${B};`, `var a=${gql("query($fullPath: ID!) { project(fullPath: $fullPath) { repository { rootRef } } }")};`]) {
    const r = check(chunk);
    assert.equal(r.code, 2, `${JSON.stringify(chunk)}\n${r.out}`);
  }
});

test("a GraphQL document with an interpolation that cannot be expanded fails loudly", () => {
  const r = check(`${READS}\nvar X=${gql("query($fullPath: ID!) { project(fullPath: $fullPath) { repository { ${frag} } } }")};`);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /interpolates \$\{frag\}/);
});
