// Structural lint for editors.yml, run by the lint:editors CI job.
// A parse error makes the Worker load an empty policy (default-deny,
// CMS bricked), and a glob that escapes the write roots is dead weight
// the Worker clips at request time; both fail the job instead.
import { readFileSync } from "node:fs";
import { exit } from "node:process";
import { parse } from "yaml";

const REPOS_KEY = "repos";

function fail(msg) {
  console.log(msg);
  exit(1);
}

const REFUSED = new Set("svg svgz html htm shtml xht xhtml xml xsl xslt js mjs cjs wasm php".split(" "));
const canonical = (path) => !/[\u0000-\u001f\u007f\\]/.test(path) && !path.split("/").some((s) => s === "" || s === "." || s === "..");
const literalPrefix = (glob) => glob.split(/[*?]/, 1)[0];
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const doc = parse(readFileSync(process.argv[2] ?? "editors.yml", "utf8"));
if (doc === null || doc === undefined) {
  fail("editors.yml parsed to null -> all writes deny. Failing the job so this can't merge.");
}
if (!isMap(doc)) fail("editors.yml top-level must be a mapping");

const { [REPOS_KEY]: policies, ...editors } = doc;
if (!isMap(policies)) fail(`editors.yml[${REPOS_KEY}] must be a mapping of repo->{branch, write_roots}`);

const roots = new Map();
for (const [repo, policy] of Object.entries(policies)) {
  const at = `editors.yml[${REPOS_KEY}][${repo}]`;
  if (!repo.includes("/")) fail(`${at} doesn't look like a repo path (group/project)`);
  if (typeof policy?.branch !== "string" || !policy.branch) fail(`${at} needs a non-empty branch string`);
  const list = policy?.write_roots;
  if (!isMap(list) || Object.keys(list).length === 0) {
    fail(`${at} needs a non-empty write_roots mapping of <dir>/** -> [extensions]`);
  }
  const dirs = [];
  for (const [root, exts] of Object.entries(list)) {
    if (!root.endsWith("/**")) {
      fail(`${at} write root ${JSON.stringify(root)} must be of the form <dir>/**`);
    }
    if (!Array.isArray(exts) || exts.length === 0 || !exts.every((e) => typeof e === "string" && /^[a-z0-9]+$/.test(e))) {
      fail(`${at} write root ${JSON.stringify(root)} needs a non-empty list of lowercase extensions without dots`);
    }
    const bad = exts.filter((e) => REFUSED.has(e));
    if (bad.length > 0) fail(`${at} write root ${JSON.stringify(root)} allows active-content extensions: ${bad.join(", ")}`);
    const dir = root.slice(0, -"/**".length);
    if (!dir || /[*?]/.test(dir) || !canonical(dir)) {
      fail(`${at} write root ${JSON.stringify(root)} must name a literal, canonical directory`);
    }
    dirs.push(`${dir}/`);
  }
  roots.set(repo, dirs);
}

for (const [email, repos] of Object.entries(editors)) {
  if (!email.includes("@")) fail(`key ${JSON.stringify(email)} doesn't look like an email`);
  if (!isMap(repos)) fail(`editors.yml[${email}] must be a mapping of repo->[paths]`);
  for (const [repo, globs] of Object.entries(repos)) {
    const at = `editors.yml[${email}][${repo}]`;
    if (!repo.includes("/")) fail(`${at} doesn't look like a repo path (group/project)`);
    if (!Array.isArray(globs)) fail(`${at} must be a list of path globs`);
    const dirs = roots.get(repo);
    if (!dirs) fail(`${at} has no ${REPOS_KEY}.${repo}.write_roots; the grant can never write`);
    for (const g of globs) {
      if (typeof g !== "string") fail(`${at} entry ${JSON.stringify(g)} must be a string`);
      const prefix = literalPrefix(g);
      if (!canonical(g.replace(/\/$/, "") || "x") || !dirs.some((d) => prefix.startsWith(d))) {
        fail(`${at} glob ${JSON.stringify(g)} escapes the write roots ${dirs.join(", ")}`);
      }
    }
  }
}

console.log(`editors.yml ok: ${Object.keys(editors).length} identities, ${roots.size} repos with write roots`);
