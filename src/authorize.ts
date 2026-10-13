// Authorization hook.
//
// `Authorizer` is the interface the proxy consults on every API
// request except the synthesized /user. The default
// implementation is built from the text of an editors.yml and matches
// the (identity, repo, path) tuple against per-editor path globs, inside
// the repo's write roots.
//
// Keeping the interface separate from the proxy lets another provider
// supply its own Authorizer; editors.yml is one.

import { parse as parseYaml } from "yaml";

export interface Identity {
  email: string;
  name: string;
}

export interface AuthorizeContext {
  identity: Identity;
  /**
   * GitLab project path, e.g. "example-org/website"; null for an
   * account-level read, which any editors.yml identity may make.
   */
  repo: string | null;
  /** HTTP method (GET, POST, PUT, DELETE, ...) */
  method: string;
  /** File path within the repo, e.g. "src/content/blog/foo.md" */
  path: string;
}

export type Authorizer = (ctx: AuthorizeContext) => boolean;

interface EditorsConfig {
  [email: string]: {
    [repo: string]: string[];
  };
}

/** The reserved top-level key; every other key is an editor's email. */
const REPOS_KEY = "repos";

interface Root {
  re: RegExp;
  exts: Set<string>;
}

interface RepoPolicies {
  [repo: string]: { branch?: string; write_roots?: { [glob: string]: string[] } } | null;
}

/**
 * Convert a path glob (`**`, `*`, `?`) to an anchored regex.
 *
 * - `**` matches any number of characters including `/`
 * - `*` matches any characters except `/`
 * - `?` matches one character except `/`
 *
 * Other regex metacharacters are escaped.
 */
function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (".+()[]{}|^$\\".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** Lowercased text after the last dot of the last segment, or null. */
function extension(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? null : name.slice(dot + 1).toLowerCase();
}

function isCanonical(path: string): boolean {
  return !/[\u0000-\u001f\u007f\\]/.test(path) && !path.split("/").some((s) => s === "" || s === "." || s === "..");
}

/**
 * Build an Authorizer from the text of an editors.yml. Identity must
 * have an entry for the target repo. Reads on account routes
 * (repo null) need any entry; reads on a repo need that repo's entry.
 * A write must be a canonical path inside one of the repo's
 * `write_roots`, carry one of that root's allowed extensions
 * (case-insensitive, last segment, no extension denied), and match one
 * of the identity's own globs. The roots bind every identity, so a repo
 * with no `write_roots` accepts no writes. The path "*" is the proxy's
 * probe for "may write anywhere"; no root matches it. The hd-claim
 * check at OAuth time still gates the domain boundary; this enforces
 * the per-repo ACL on top.
 */
export function buildAuthorizer(yamlText: string): Authorizer {
  const doc = (parseYaml(yamlText) as Record<string, unknown> | null) ?? {};
  const { [REPOS_KEY]: repoPolicies, ...editors } = doc;

  // Maps, so a repo or email named "constructor" or "__proto__" is not
  // found.
  const roots = new Map<string, Root[]>();
  for (const [repo, policy] of Object.entries((repoPolicies as RepoPolicies | null) ?? {})) {
    roots.set(
      repo,
      Object.entries(policy?.write_roots ?? {}).map(([glob, exts]) => ({
        re: globToRegex(glob),
        exts: new Set((exts ?? []).map((e) => e.toLowerCase())),
      })),
    );
  }
  const compiled = new Map<string, Map<string, RegExp[]>>();
  for (const [email, repos] of Object.entries(editors as EditorsConfig)) {
    const byRepo = new Map<string, RegExp[]>();
    for (const [repo, globs] of Object.entries(repos ?? {})) {
      byRepo.set(repo, (globs ?? []).map(globToRegex));
    }
    compiled.set(email, byRepo);
  }
  return ({ identity, repo, method, path }) => {
    const repos = compiled.get(identity.email);
    if (!repos) return false;
    if (repo === null) return method === "GET" && repos.size > 0;
    const patterns = repos.get(repo);
    if (!patterns) return false;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return true;
    }
    if (!isCanonical(path)) return false;
    const ext = extension(path);
    if (!roots.get(repo)?.some((r) => r.re.test(path) && ext !== null && r.exts.has(ext))) {
      return false;
    }
    return patterns.some((p) => p.test(path));
  };
}

/**
 * The one branch a repo's commits may target, from its `branch` in
 * editors.yml; undefined when none is configured.
 */
export type BranchResolver = (repo: string) => string | undefined;

export function buildBranchResolver(yamlText: string): BranchResolver {
  const doc = (parseYaml(yamlText) as Record<string, unknown> | null) ?? {};
  const branches = new Map<string, string>();
  for (const [repo, policy] of Object.entries((doc[REPOS_KEY] as RepoPolicies | null) ?? {})) {
    if (typeof policy?.branch === "string") branches.set(repo, policy.branch);
  }
  return (repo) => branches.get(repo);
}

/** An identity with at least one repo in editors.yml; the OAuth callback mints JWTs only for these. */
export function buildIsEditor(yamlText: string): (email: string) => boolean {
  const doc = (parseYaml(yamlText) as Record<string, unknown> | null) ?? {};
  const { [REPOS_KEY]: _repos, ...editors } = doc;
  const known = new Map<string, number>();
  for (const [email, repos] of Object.entries(editors as EditorsConfig)) {
    known.set(email, Object.keys(repos ?? {}).length);
  }
  return (email) => (known.get(email) ?? 0) > 0;
}

