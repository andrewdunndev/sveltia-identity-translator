// Reads what Sveltia's GitLab backend can send out of its bundled
// chunk, as text: the chunk is never imported or run. Used by
// sveltia-contract.mjs.
//
// The chunk is minified JS. A small scanner finds every template
// literal (skipping strings, comments and regex literals, which can
// hold backticks or quotes), keeping each `${...}` as an expression.
// An expression of the form `c ? `a` : `b`` expands both ways; any
// other expression in a GraphQL document is an error, since its value
// cannot be known from the text.

const REGEX_BEFORE = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await"]);

/**
 * @typedef {{ start: number, end: number, parts: Array<string | Expr> }} Template
 * @typedef {{ src: string, templates: Template[] }} Expr
 */

/** Every template literal in `text`, outermost first, nested ones inside their expressions. */
export function templates(text) {
  const out = [];
  let i = 0;
  const n = text.length;

  // Code until `stop` (a "}" closing an expression) or the end. Returns
  // the index after the stop char and the templates seen at this level.
  function code(stopAtBrace) {
    const found = [];
    let depth = 0;
    let prev = ""; // last significant char, for regex detection
    let word = ""; // last identifier, for `return /re/`
    while (i < n) {
      const c = text[i];
      if (c === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
      if (c === "/" && (prev === "" || REGEX_BEFORE.has(prev) || REGEX_AFTER_WORD.has(word))) {
        regex();
        prev = "/";
        word = "";
        continue;
      }
      if (c === "'" || c === '"') {
        quoted(c);
        prev = c;
        word = "";
        continue;
      }
      if (c === "`") {
        found.push(template());
        prev = "`";
        word = "";
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (depth === 0 && stopAtBrace) {
          i++;
          return found;
        }
        depth--;
      }
      if (/[\w$]/.test(c)) {
        word = /[\w$]/.test(prev) ? word + c : c;
      } else if (!/\s/.test(c)) {
        word = "";
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
    return found;
  }

  function quoted(q) {
    i++;
    while (i < n && text[i] !== q) i += text[i] === "\\" ? 2 : 1;
    i++;
  }

  function regex() {
    i++;
    let cls = false;
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") return; // was division after all
      if (cls) {
        if (c === "]") cls = false;
      } else if (c === "[") {
        cls = true;
      } else if (c === "/") {
        i++;
        while (i < n && /[a-z]/i.test(text[i])) i++;
        return;
      }
      i++;
    }
  }

  function template() {
    const start = i;
    i++;
    const parts = [];
    let lit = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        lit += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        if (lit) parts.push(lit);
        return { start, end: i, parts };
      }
      if (c === "$" && text[i + 1] === "{") {
        if (lit) parts.push(lit);
        lit = "";
        i += 2;
        const from = i;
        const inner = code(true);
        parts.push({ src: text.slice(from, i - 1), templates: inner });
        continue;
      }
      lit += c;
      i++;
    }
    throw new Error(`unterminated template literal at ${start}`);
  }

  out.push(...code(false));
  return out;
}

/** All templates, nested ones included, in source order. */
export function allTemplates(text) {
  const flat = [];
  const walk = (ts) => {
    for (const t of ts) {
      flat.push(t);
      for (const p of t.parts) if (typeof p !== "string") walk(p.templates);
    }
  };
  walk(templates(text));
  return flat.sort((a, b) => a.start - b.start);
}

// `cond ? `a` : `b`` with nothing else in the expression: the
// condition's text and the two branches.
function conditional(expr) {
  if (expr.templates.length !== 2) return null;
  const rest = expr.src.replace(/`(?:\\[\s\S]|[^`\\])*`/g, "T");
  const m = /^\s*([\w$.!?()\s]*?)\s*\?\s*T\s*:\s*T\s*$/.exec(rest);
  return m ? { cond: m[1], branches: expr.templates } : null;
}

function conditions(t, into = new Set()) {
  for (const p of t.parts) {
    if (typeof p === "string") continue;
    const c = conditional(p);
    if (c) {
      into.add(c.cond);
      for (const b of c.branches) conditions(b, into);
    }
  }
  return into;
}

function render(t, truth, other) {
  return t.parts
    .map((p) => {
      if (typeof p === "string") return p;
      const c = conditional(p);
      return c ? render(c.branches[truth.get(c.cond) ? 0 : 1], truth, other) : other(p);
    })
    .join("");
}

/**
 * Every string the template can produce, taking each distinct
 * condition both ways (the same condition in two places takes the same
 * branch in both). `other(expr)` stands in for any other expression:
 * it returns the text to use, or throws.
 */
export function expand(t, other) {
  const conds = [...conditions(t)];
  if (conds.length > 8) throw new Error(`template at ${t.start} has ${conds.length} conditions`);
  const out = new Set();
  for (let bits = 0; bits < 1 << conds.length; bits++) {
    out.add(render(t, new Map(conds.map((c, k) => [c, Boolean(bits & (1 << k))])), other));
  }
  return [...out];
}

const GRAPHQL_START = /^\s*(query|mutation|subscription|fragment)\b|^\s*\{\s*\w/;

/** GraphQL documents: templates whose text opens like one, or that name a fullPath variable. */
export function graphqlDocs(text) {
  const docs = [];
  for (const t of allTemplates(text)) {
    const head = typeof t.parts[0] === "string" ? t.parts[0] : "";
    const flatText = t.parts.map((p) => (typeof p === "string" ? p : "")).join("");
    if (!GRAPHQL_START.test(head) && !/\bfullPath\b/.test(flatText)) continue;
    const variants = expand(t, (e) => {
      throw new Error(`graphql document at ${t.start} interpolates \${${e.src.slice(0, 60)}}`);
    });
    for (const v of variants) docs.push({ at: t.start, text: v.replace(/\s+/g, " ").trim() });
  }
  return docs;
}

// Placeholder for an interpolated path segment or query value.
const VALUE = "x";
const API_PATH = /^\/[a-z_]/i;

/**
 * REST paths: templates that start with "/" (API paths relative to the
 * REST root; "/-/..." web links excepted), with any interpolation in
 * the path taken as a value. A query string interpolated whole,
 * `?${p}`, is read from `p=new URLSearchParams({...})` when the chunk
 * builds it that way; what it cannot read is listed in `unknown`. A
 * path that starts with an interpolation resolves through a helper
 * (`G=e=>`/projects/...``) or the nearest `i=`/projects/...`` before
 * it; failing that it is returned with `unresolved` set.
 */
export function restPaths(text) {
  const all = allTemplates(text);
  const pathTemplate = (t) => typeof t.parts[0] === "string" && API_PATH.test(t.parts[0]);
  const helpers = new Map();
  for (const t of all) {
    const m = /([\w$]+)=(?:\([\w$,{}:\s]*\)|[\w$]+)=>$/.exec(text.slice(Math.max(0, t.start - 40), t.start));
    if (m && pathTemplate(t)) helpers.set(m[1], t);
  }
  const assigned = (name, before) => {
    let best = null;
    for (const t of all) {
      if (t.start >= before || t.start < before - 600 || !pathTemplate(t)) continue;
      if (text.slice(t.start - name.length - 1, t.start) === `${name}=`) best = t;
    }
    return best;
  };

  const out = [];
  for (const t of all) {
    let prefix = "";
    let parts = t.parts;
    const first = parts[0];
    if (first === undefined) continue;
    if (typeof first !== "string") {
      if (typeof parts[1] !== "string" || !API_PATH.test(parts[1])) continue;
      const call = /^([\w$]+)\(/.exec(first.src);
      const name = first.src.trim();
      const base = (call && helpers.get(call[1])) ?? (/^[\w$]+$/.test(name) ? assigned(name, t.start) : null);
      if (!base) {
        out.push({ at: t.start, method: "GET", path: `{${name.slice(0, 40)}}${parts[1]}`, unknown: [], unresolved: true });
        continue;
      }
      prefix = expand(base, () => VALUE)[0];
      parts = parts.slice(1);
    } else if (!API_PATH.test(first)) {
      continue;
    }
    const before = text.slice(Math.max(0, t.start - 400), t.start);
    const after = text.slice(t.end, t.end + 80);
    const method = /^\s*,\s*\{\s*method:\s*[`'"](\w+)[`'"]/.exec(after)?.[1] ?? "GET";
    const exprs = [];
    const variants = expand({ ...t, parts }, (e) => {
      exprs.push(e.src.trim());
      return `\u0001${exprs.length - 1}\u0001`;
    });
    for (const v of variants) {
      const unknown = [];
      const path = (prefix + v)
        .replace(/([?&])\u0001(\d+)\u0001(?=&|$)/g, (_, sep, k) => {
          const name = exprs[+k];
          const qs = new RegExp(`(?:^|[,;{\\s])${name.replace(/\$/g, "\\$")}=new URLSearchParams\\(\\{([^)]*)\\}\\)`).exec(before);
          if (!qs) {
            unknown.push(name.slice(0, 40));
            return sep;
          }
          const keys = [];
          for (const piece of topLevel(qs[1])) {
            const known = /^\.\.\.[\w$]+&&\{([\w$]+):/.exec(piece) ?? /^([\w$]+)\s*:/.exec(piece);
            if (known) keys.push(`${known[1]}=${VALUE}`);
            else unknown.push(piece.slice(0, 40));
          }
          return sep + keys.join("&");
        })
        .replace(/\u0001\d+\u0001/g, VALUE)
        .replace(/[?&]$/, "");
      out.push({ at: t.start, method, path, unknown });
    }
  }
  return out;
}

// Comma-separated pieces of an object literal's body, at brace depth 0.
function topLevel(src) {
  const pieces = [];
  let depth = 0;
  let cur = "";
  for (const c of src) {
    if (c === "{" || c === "(" || c === "[") depth++;
    if (c === "}" || c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      pieces.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  pieces.push(cur.trim());
  return pieces.filter(Boolean);
}
