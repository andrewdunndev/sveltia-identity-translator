// Authorization hook for the translator.
//
// `Authorizer` is the interface the proxy consults on every request
// against a /projects/<repo>/... endpoint. The default implementation
// loads editors.yml at module init and matches the (identity, repo,
// path) tuple against per-editor path globs.
//
// Keeping the interface separate from the proxy is the upstream-
// readiness shape: a maintainer in sveltia/sveltia-cms-auth could
// import the proxy module and supply their own Authorizer (e.g. one
// backed by a database, an LDAP query, or a per-org policy engine).
// The default editorsYmlAuthorizer is one provider; the hook is the
// contract.

import editorsYaml from "../editors.yml";
import { parse as parseYaml } from "yaml";

export interface Identity {
  email: string;
  name: string;
}

export interface AuthorizeContext {
  identity: Identity;
  /** GitLab project path, e.g. "your-org/your-site" */
  repo: string;
  /** HTTP method (GET, POST, PUT, DELETE, ...) */
  method: string;
  /** File path within the repo, e.g. "src/content/blog/foo.md", or "*" for read-membership checks */
  path: string;
}

export type Authorizer = (ctx: AuthorizeContext) => boolean;

interface EditorsConfig {
  [email: string]: {
    [repo: string]: string[];
  };
}

const editors: EditorsConfig =
  (parseYaml(editorsYaml) as EditorsConfig | null) ?? {};

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

const compiled: Record<string, Record<string, RegExp[]>> = {};
for (const email of Object.keys(editors)) {
  compiled[email] = {};
  const repos = editors[email] ?? {};
  for (const repo of Object.keys(repos)) {
    compiled[email][repo] = (repos[repo] ?? []).map(globToRegex);
  }
}

/**
 * Default Authorizer. Identity must have an editors.yml entry for
 * the target repo. For reads, that membership is sufficient. For
 * writes, one of the identity's path globs under that repo must
 * match the file path. The hd-claim check at OAuth time still gates
 * the domain boundary; this enforces the per-repo ACL on top.
 */
export const editorsYmlAuthorizer: Authorizer = ({ identity, repo, method, path }) => {
  const repos = compiled[identity.email];
  if (!repos) return false;
  const patterns = repos[repo];
  if (!patterns) return false;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }
  for (const pattern of patterns) {
    if (pattern.test(path)) return true;
  }
  return false;
};
