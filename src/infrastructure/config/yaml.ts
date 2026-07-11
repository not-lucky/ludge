/**
 * A strict, hand-rolled parser for the small YAML subset `problem.yaml` uses.
 *
 * The judge deliberately does NOT pull in a general YAML dependency (the project
 * ships zero runtime dependencies and hand-rolls its JSON reader for the same
 * reason). A full YAML engine would also accept far more than the problem schema
 * needs — anchors, tags, multi-document streams, block scalars — each an avenue
 * for surprising or unsafe configuration. This reader instead accepts a tightly
 * bounded block-mapping subset and treats everything outside it as an error.
 *
 * Supported constructs:
 *   - a root block mapping of `key: value` entries;
 *   - nested block mappings (used by `limits:`), indented with spaces;
 *   - scalars: plain and quoted strings, decimal integers, `true`/`false`,
 *     and `null`/`~`;
 *   - the empty flow collections `{}` and `[]`;
 *   - `#` line comments and blank lines.
 *
 * Rejected as errors (never silently ignored): duplicate keys, tab indentation,
 * inconsistent indentation, non-empty flow collections, block scalars, anchors,
 * tags, and any other unsupported syntax.
 *
 * Like {@link parseJson}, this returns a result union for malformed input rather
 * than throwing, so callers treat a parse failure as ordinary control flow.
 */

/**
 * A parsed YAML value as a discriminated union.
 *
 * Integers retain their raw source text in `raw` (never converted to a JS
 * number here) so the schema loader can bound-check the digits before a lossy
 * numeric conversion. The root node returned by {@link parseYaml} is always a
 * `map`.
 */
export type YamlNode =
  | { readonly kind: "null" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "int"; readonly raw: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "list"; readonly items: readonly YamlNode[] }
  | { readonly kind: "map"; readonly entries: ReadonlyMap<string, YamlNode> };

/** A structured description of where and why YAML parsing failed. */
export interface YamlParseError {
  /** Human-readable, bounded description of the failure. */
  readonly message: string;
  /** 1-based source line the error was detected on (`0` if not line-specific). */
  readonly line: number;
}

/** The result of {@link parseYaml}: the parsed root map or a structured error. */
export type YamlParseResult =
  | { readonly ok: true; readonly node: YamlNode }
  | { readonly ok: false; readonly error: YamlParseError };

/**
 * Maximum block-mapping nesting depth accepted.
 *
 * `problem.yaml` needs only one level of nesting (`limits:`), so this generous
 * bound simply guards against pathological input while leaving legitimate
 * documents unaffected.
 */
export const YAML_MAX_DEPTH = 16;

/** A single significant source line after comment stripping. */
interface PhysicalLine {
  /** Number of leading space characters (the indentation column). */
  readonly indent: number;
  /** The line content after the indent, comment-stripped and end-trimmed. */
  readonly text: string;
  /** 1-based source line number, for diagnostics. */
  readonly line: number;
}

/** Internal control-flow signal carrying a parse failure out of recursion. */
class YamlAbort extends Error {
  public constructor(
    public readonly detail: string,
    public readonly lineNo: number,
  ) {
    super(detail);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Parse a `problem.yaml`-style document under the strict subset grammar.
 *
 * Never throws for malformed input: any unsupported construct, structural
 * error, duplicate key, or tab-indented line is reported as
 * `{ ok: false, error }`. The root is always a mapping; a document whose root
 * is a scalar or list is rejected.
 *
 * @param text - The complete document text.
 * @returns A success result carrying the root `map` node, or a failure result
 *   carrying a {@link YamlParseError}.
 */
export function parseYaml(text: string): YamlParseResult {
  try {
    const lines = tokenizeLines(text);
    if (lines.length === 0) {
      // An empty document is an empty mapping.
      return { ok: true, node: { kind: "map", entries: new Map() } };
    }
    const first = lines[0];
    if (first !== undefined && first.indent !== 0) {
      throw new YamlAbort("document must start at the left margin", first.line);
    }
    const { node, next } = parseMapping(lines, 0, 0, 1);
    if (next < lines.length) {
      const stray = lines[next];
      throw new YamlAbort(
        "unexpected indentation or trailing content",
        stray === undefined ? 0 : stray.line,
      );
    }
    return { ok: true, node };
  } catch (err) {
    if (err instanceof YamlAbort) {
      return { ok: false, error: { message: err.detail, line: err.lineNo } };
    }
    throw err;
  }
}

/**
 * Split the source into significant {@link PhysicalLine}s.
 *
 * Comments and blank lines are dropped; tab-indented lines are rejected so
 * indentation is unambiguous (a common YAML footgun the spec forbids).
 */
function tokenizeLines(text: string): PhysicalLine[] {
  const rawLines = text.split(/\r\n|\r|\n/u);
  const result: PhysicalLine[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? "";
    const lineNo = i + 1;

    // Measure the indent and reject tabs within it.
    let indent = 0;
    while (indent < raw.length) {
      const ch = raw.charCodeAt(indent);
      if (ch === 0x20) {
        indent += 1;
      } else if (ch === 0x09) {
        throw new YamlAbort("tab characters are not allowed in indentation", lineNo);
      } else {
        break;
      }
    }

    const withoutComment = stripComment(raw.slice(indent));
    const text2 = withoutComment.replace(/\s+$/u, "");
    if (text2.length === 0) {
      continue; // blank or comment-only line
    }
    result.push({ indent, text: text2, line: lineNo });
  }
  return result;
}

/**
 * Remove a trailing `#` comment from a line body, respecting quoted strings.
 *
 * A `#` opens a comment only at the start of the body or when preceded by
 * whitespace; a `#` inside a quoted scalar (or immediately following a
 * non-space character) is preserved as literal text.
 */
function stripComment(body: string): string {
  let quote = 0; // 0 = none, otherwise the open-quote char code
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charCodeAt(i);
    if (quote !== 0) {
      if (ch === quote) {
        quote = 0;
      }
      continue;
    }
    if (ch === 0x22 || ch === 0x27) {
      quote = ch; // enter a double- or single-quoted span
      continue;
    }
    if (ch === 0x23) {
      const prev = i === 0 ? 0x20 : body.charCodeAt(i - 1);
      if (prev === 0x20 || prev === 0x09) {
        return body.slice(0, i);
      }
    }
  }
  return body;
}

/**
 * Parse a block mapping whose entries all sit at column `indent`.
 *
 * @param lines - All significant lines.
 * @param start - Index of the first line to consider.
 * @param indent - The exact column shared by this mapping's keys.
 * @param depth - Current nesting depth, guarded by {@link YAML_MAX_DEPTH}.
 * @returns The mapping node and the index of the first line not consumed.
 */
function parseMapping(
  lines: readonly PhysicalLine[],
  start: number,
  indent: number,
  depth: number,
): { node: YamlNode; next: number } {
  if (depth > YAML_MAX_DEPTH) {
    const at = lines[start];
    throw new YamlAbort(
      `maximum nesting depth ${YAML_MAX_DEPTH} exceeded`,
      at === undefined ? 0 : at.line,
    );
  }

  const entries = new Map<string, YamlNode>();
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) {
      break; // belongs to an enclosing mapping
    }
    if (line.indent > indent) {
      throw new YamlAbort("unexpected indentation", line.line);
    }

    const { key, rest } = splitKey(line);
    if (entries.has(key)) {
      throw new YamlAbort(`duplicate key '${key}'`, line.line);
    }

    if (rest.length > 0) {
      // Inline scalar (or empty flow collection) on the same line.
      entries.set(key, parseScalar(rest, line.line));
      index += 1;
      continue;
    }

    // No inline value: either a nested block mapping or an explicit null.
    const child = lines[index + 1];
    if (child !== undefined && child.indent > indent) {
      const nested = parseMapping(lines, index + 1, child.indent, depth + 1);
      entries.set(key, nested.node);
      index = nested.next;
    } else {
      entries.set(key, { kind: "null" });
      index += 1;
    }
  }

  return { node: { kind: "map", entries }, next: index };
}

/**
 * Split a `key: value` line into its key and the (possibly empty) remainder.
 *
 * The key is a plain identifier or a quoted string; the first `: ` (or a
 * trailing `:`) separates it from the value.
 */
function splitKey(line: PhysicalLine): { key: string; rest: string } {
  const body = line.text;
  if (body.charCodeAt(0) === 0x22 || body.charCodeAt(0) === 0x27) {
    // Quoted key: find the matching close quote, then the following colon.
    const quote = body.charCodeAt(0);
    let i = 1;
    while (i < body.length && body.charCodeAt(i) !== quote) {
      i += 1;
    }
    if (i >= body.length) {
      throw new YamlAbort("unterminated quoted key", line.line);
    }
    const key = body.slice(1, i);
    const after = body.slice(i + 1).replace(/^\s*/u, "");
    if (after.charCodeAt(0) !== 0x3a) {
      throw new YamlAbort("expected ':' after key", line.line);
    }
    return { key, rest: after.slice(1).replace(/^\s+/u, "") };
  }

  const colon = findKeyColon(body, line.line);
  const key = body.slice(0, colon).replace(/\s+$/u, "");
  if (key.length === 0) {
    throw new YamlAbort("missing mapping key", line.line);
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) {
    throw new YamlAbort(`invalid mapping key '${key}'`, line.line);
  }
  return { key, rest: body.slice(colon + 1).replace(/^\s+/u, "") };
}

/** Find the index of the key/value separator colon in a plain-key line. */
function findKeyColon(body: string, lineNo: number): number {
  for (let i = 0; i < body.length; i += 1) {
    if (body.charCodeAt(i) === 0x3a) {
      // A colon terminates the key when it ends the line or is followed by
      // whitespace; `a:b` (no space) is not a valid mapping separator here.
      const nextCh = i + 1 < body.length ? body.charCodeAt(i + 1) : 0x20;
      if (nextCh === 0x20 || nextCh === 0x09) {
        return i;
      }
      if (i + 1 >= body.length) {
        return i;
      }
    }
  }
  throw new YamlAbort("expected 'key: value' mapping entry", lineNo);
}

/**
 * Parse an inline scalar value into a {@link YamlNode}.
 *
 * Recognizes quoted strings, `null`/`~`, `true`/`false`, decimal integers, the
 * empty flow collections `{}`/`[]`, and otherwise a plain string. Non-empty
 * flow collections and block/anchor sigils are rejected.
 */
function parseScalar(value: string, lineNo: number): YamlNode {
  const first = value.charCodeAt(0);

  if (first === 0x22) {
    return { kind: "string", value: parseDoubleQuoted(value, lineNo) };
  }
  if (first === 0x27) {
    return { kind: "string", value: parseSingleQuoted(value, lineNo) };
  }

  if (value === "{}") {
    return { kind: "map", entries: new Map() };
  }
  if (value === "[]") {
    return { kind: "list", items: [] };
  }
  if (value === "null" || value === "~") {
    return { kind: "null" };
  }
  if (value === "true") {
    return { kind: "bool", value: true };
  }
  if (value === "false") {
    return { kind: "bool", value: false };
  }
  if (/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    return { kind: "int", raw: value };
  }

  // Reject constructs this subset intentionally does not support.
  if (
    first === 0x7b || // '{'
    first === 0x5b || // '['
    first === 0x26 || // '&' anchor
    first === 0x2a || // '*' alias
    first === 0x7c || // '|' block scalar
    first === 0x3e || // '>' folded scalar
    first === 0x21 // '!' tag
  ) {
    throw new YamlAbort(`unsupported YAML value '${value}'`, lineNo);
  }

  return { kind: "string", value };
}

/** Parse a double-quoted scalar, decoding a small set of C-style escapes. */
function parseDoubleQuoted(value: string, lineNo: number): string {
  let out = "";
  let i = 1;
  for (;;) {
    if (i >= value.length) {
      throw new YamlAbort("unterminated double-quoted string", lineNo);
    }
    const ch = value.charCodeAt(i);
    if (ch === 0x22) {
      if (i !== value.length - 1) {
        throw new YamlAbort("trailing content after quoted string", lineNo);
      }
      return out;
    }
    if (ch === 0x5c) {
      const esc = value.charCodeAt(i + 1);
      switch (esc) {
        case 0x22:
          out += '"';
          break;
        case 0x5c:
          out += "\\";
          break;
        case 0x6e:
          out += "\n";
          break;
        case 0x74:
          out += "\t";
          break;
        case 0x30:
          out += "\0";
          break;
        default:
          throw new YamlAbort("invalid escape in double-quoted string", lineNo);
      }
      i += 2;
      continue;
    }
    out += value[i];
    i += 1;
  }
}

/**
 * Parse a single-quoted scalar. Only the doubled-quote escape (`''` → `'`) is
 * recognized, exactly as YAML specifies for single-quoted flow scalars.
 */
function parseSingleQuoted(value: string, lineNo: number): string {
  let out = "";
  let i = 1;
  for (;;) {
    if (i >= value.length) {
      throw new YamlAbort("unterminated single-quoted string", lineNo);
    }
    const ch = value.charCodeAt(i);
    if (ch === 0x27) {
      if (value.charCodeAt(i + 1) === 0x27) {
        out += "'";
        i += 2;
        continue;
      }
      if (i !== value.length - 1) {
        throw new YamlAbort("trailing content after quoted string", lineNo);
      }
      return out;
    }
    out += value[i];
    i += 1;
  }
}
