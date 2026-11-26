// The Sveltia calls this translator denies on purpose, for the
// contract checker (scripts/sveltia-contract.mjs). The checker runs
// every GraphQL document and REST path a Sveltia release can send
// through the Worker; a denied one fails the check unless its key is
// matched here, and then it is reported as excluded, never skipped.
//
// Keys:
//   graphql <at>                  the deny log's at=, e.g. project.mergeRequests
//   rest <METHOD> <path>          a route the table does not serve
//   rest <METHOD> <path>?<param>  a query parameter the route drops
// <path> has no leading slash; the project is {repo}, any other
// interpolated value {}, and {} also stands for a path prefix the
// checker could not resolve. "*" matches anything, method included.

export interface Exclusion {
  key: string;
  why: string;
}

export const CONTRACT_EXCLUSIONS: readonly Exclusion[] = [
  // Editorial workflow: entries live on branches and merge requests
  // until published. The translator serves simple publish mode only,
  // commits straight to the one branch editors.yml names, so a site
  // behind it never sends these; a merge is a write the path
  // allowlist would not see.
  { key: "graphql project.mergeRequests", why: "editorial workflow" },
  { key: "rest * projects/{repo}/merge_requests*", why: "editorial workflow" },
  { key: "rest * {}/approv*", why: "editorial workflow: merge request approval" },
  { key: "rest * {}/unapprove", why: "editorial workflow: merge request approval" },
  { key: "rest GET projects/{repo}/repository/compare", why: "editorial workflow: entry branch diff" },
  // Only the two params Sveltia's entry-branch search sends; a param
  // dropped anywhere else on this route still fails.
  { key: "rest GET projects/{repo}/repository/branches?search", why: "editorial workflow: entry branch search" },
  { key: "rest GET projects/{repo}/repository/branches?per_page", why: "editorial workflow: entry branch search" },

  // Open authoring: contributors without push access work in forks.
  // Every editor here pushes as the service account instead.
  { key: "rest GET projects/{repo}", why: "open authoring: fork and permission checks" },
  { key: "rest * projects/{repo}/fork*", why: "open authoring: forks" },

  // Sveltia's publish button with backend.automatic_deployments: false.
  // The translator does not run pipelines.
  { key: "rest POST projects/{repo}/pipeline", why: "manual deploy trigger" },

  // Paths in the chunk that are not REST API calls.
  { key: "rest GET token", why: "OAuth token path under the auth root (oauth.ts)" },
  { key: "rest GET api/graphql", why: "graphql_api_root derived from api_root; documents are checked as graphql" },
];

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

const compiled = CONTRACT_EXCLUSIONS.map((e) => ({ ...e, re: glob(e.key) }));

/** The first exclusion whose key matches, if any. */
export function exclusionFor(key: string): Exclusion | undefined {
  return compiled.find((e) => e.re.test(key));
}
