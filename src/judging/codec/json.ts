/**
 * A strict, hand-rolled recursive-descent JSON parser.
 *
 * The codec deliberately does NOT use the platform `JSON.parse`, because it
 * needs guarantees `JSON.parse` cannot give:
 *   (a) duplicate object keys must be rejected (the platform keeps the last),
 *   (b) number tokens must be preserved as their exact raw source text (the
 *       platform lossily converts to an IEEE-754 double),
 *   (c) the JSON5-ish laxities some engines tolerate must be rejected.
 *
 * The parser returns a {@link JsonParseResult} for any malformed input rather
 * than throwing, so callers can treat parse failure as ordinary control flow.
 */

/**
 * A parsed JSON value as a discriminated union.
 *
 * Numbers retain their raw source substring in `raw` (never converted to a JS
 * number) so downstream canonicalization can inspect the exact digits. Objects
 * store members in a {@link ReadonlyMap}, which preserves insertion order;
 * callers must not rely on that order for semantics.
 */
export type JsonNode =
  | { readonly kind: "null" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "number"; readonly raw: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly JsonNode[] }
  | { readonly kind: "object"; readonly members: ReadonlyMap<string, JsonNode> };

/**
 * A structured description of where and why parsing failed.
 */
export interface JsonParseError {
  /** Human-readable, bounded description of the failure. */
  readonly message: string;
  /** 0-based character index where the error was detected (best effort). */
  readonly position: number;
}

/**
 * The result of {@link parseJson}: either the parsed root node or an error.
 */
export type JsonParseResult =
  | { readonly ok: true; readonly node: JsonNode }
  | { readonly ok: false; readonly error: JsonParseError };

/**
 * Maximum structural nesting depth the parser will descend into.
 *
 * This is a stack-safety guard against adversarial deeply-nested input; it is
 * intentionally far above the codec's semantic depth limit (256), which is
 * enforced later against the parsed tree. Exceeding it is a parse error, not a
 * native stack overflow crash.
 */
export const JSON_MAX_STRUCTURAL_DEPTH = 4096;

/**
 * Internal control-flow signal carrying a parse failure out of deep recursion.
 *
 * It is thrown by the parser's helpers and caught once at the top level, where
 * it becomes a {@link JsonParseError}. It never escapes {@link parseJson}.
 */
class ParseAbort extends Error {
  public constructor(
    public readonly detail: string,
    public readonly position: number,
  ) {
    super(detail);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/** Character codes for the four structural whitespace characters JSON allows. */
const CHAR_SPACE = 0x20;
const CHAR_TAB = 0x09;
const CHAR_LF = 0x0a;
const CHAR_CR = 0x0d;

/**
 * The mutable parser state for a single {@link parseJson} call.
 *
 * Holds the source text and a cursor `pos`. All index reads go through
 * {@link peek}, which returns `-1` past the end so callers never touch an
 * `undefined` (satisfying `noUncheckedIndexedAccess` without scattered guards).
 */
class Parser {
  private pos = 0;
  private depth = 0;

  public constructor(private readonly text: string) {}

  /** Parse exactly one top-level value plus trailing whitespace only. */
  public parseDocument(): JsonNode {
    this.skipWhitespace();
    if (this.pos >= this.text.length) {
      throw new ParseAbort("unexpected end of input", this.pos);
    }
    const node = this.parseValue();
    this.skipWhitespace();
    if (this.pos < this.text.length) {
      throw new ParseAbort(
        `unexpected trailing content at position ${this.pos}`,
        this.pos,
      );
    }
    return node;
  }

  /** Return the char code at the cursor, or `-1` if at/after end of input. */
  private peek(): number {
    return this.pos < this.text.length ? this.text.charCodeAt(this.pos) : -1;
  }

  /** Return the char code at the cursor and advance, or `-1` at end of input. */
  private next(): number {
    if (this.pos >= this.text.length) {
      return -1;
    }
    const code = this.text.charCodeAt(this.pos);
    this.pos += 1;
    return code;
  }

  /** Advance past any run of the four allowed whitespace characters. */
  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const code = this.text.charCodeAt(this.pos);
      if (
        code === CHAR_SPACE ||
        code === CHAR_TAB ||
        code === CHAR_LF ||
        code === CHAR_CR
      ) {
        this.pos += 1;
      } else {
        break;
      }
    }
  }

  /** Dispatch on the current character to the matching value parser. */
  private parseValue(): JsonNode {
    const code = this.peek();
    switch (code) {
      case 0x7b: // '{'
        return this.parseObject();
      case 0x5b: // '['
        return this.parseArray();
      case 0x22: // '"'
        return { kind: "string", value: this.parseString() };
      case 0x74: // 't'
        this.parseKeyword("true");
        return { kind: "bool", value: true };
      case 0x66: // 'f'
        this.parseKeyword("false");
        return { kind: "bool", value: false };
      case 0x6e: // 'n'
        this.parseKeyword("null");
        return { kind: "null" };
      default:
        if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
          return { kind: "number", raw: this.parseNumber() };
        }
        throw new ParseAbort(this.unexpectedHere(), this.pos);
    }
  }

  /** Consume an exact keyword literal (`true`/`false`/`null`). */
  private parseKeyword(word: string): void {
    const start = this.pos;
    for (let i = 0; i < word.length; i += 1) {
      // Safe: comparing against the fixed literal; `next()` returns -1 at end.
      if (this.next() !== word.charCodeAt(i)) {
        throw new ParseAbort(`invalid literal at position ${start}`, start);
      }
    }
  }

  /**
   * Parse a number and return its exact raw source substring.
   *
   * Grammar: `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`. This is
   * validated by hand rather than by a single regex so failures point at a
   * precise position and so leading zeros, bare `.5`/`5.`, and a leading `+`
   * are all rejected.
   */
  private parseNumber(): string {
    const start = this.pos;

    // Optional minus sign.
    if (this.peek() === 0x2d) {
      this.pos += 1;
    }

    // Integer part: a single '0', or a nonzero digit followed by more digits.
    const intFirst = this.peek();
    if (intFirst === 0x30) {
      this.pos += 1; // leading zero must stand alone
    } else if (intFirst >= 0x31 && intFirst <= 0x39) {
      this.pos += 1;
      while (this.isDigit(this.peek())) {
        this.pos += 1;
      }
    } else {
      throw new ParseAbort("invalid number literal", start);
    }

    // Optional fractional part: '.' then at least one digit.
    if (this.peek() === 0x2e) {
      this.pos += 1;
      if (!this.isDigit(this.peek())) {
        throw new ParseAbort("invalid number literal", start);
      }
      while (this.isDigit(this.peek())) {
        this.pos += 1;
      }
    }

    // Optional exponent: 'e'/'E', optional sign, at least one digit.
    const expMarker = this.peek();
    if (expMarker === 0x65 || expMarker === 0x45) {
      this.pos += 1;
      const sign = this.peek();
      if (sign === 0x2b || sign === 0x2d) {
        this.pos += 1;
      }
      if (!this.isDigit(this.peek())) {
        throw new ParseAbort("invalid number literal", start);
      }
      while (this.isDigit(this.peek())) {
        this.pos += 1;
      }
    }

    return this.text.slice(start, this.pos);
  }

  /** Whether `code` is an ASCII decimal digit. */
  private isDigit(code: number): boolean {
    return code >= 0x30 && code <= 0x39;
  }

  /**
   * Parse a double-quoted string, decoding escapes.
   *
   * Handles `\" \\ \/ \b \f \n \r \t` and `\uXXXX`; a valid high+low `\u`
   * surrogate pair is combined into its astral code point. A lone `\u`
   * surrogate is deliberately preserved as a lone code unit (surrogate
   * validity is checked elsewhere by the codec). Literal control characters
   * U+0000..U+001F are rejected.
   */
  private parseString(): string {
    // Consume the opening quote.
    if (this.next() !== 0x22) {
      throw new ParseAbort("expected string", this.pos - 1);
    }
    let out = "";
    for (;;) {
      const code = this.next();
      if (code === -1) {
        throw new ParseAbort("unterminated string", this.pos);
      }
      if (code === 0x22) {
        return out; // closing quote
      }
      if (code === 0x5c) {
        out += this.parseEscape();
        continue;
      }
      if (code <= 0x1f) {
        throw new ParseAbort(
          `unescaped control character at position ${this.pos - 1}`,
          this.pos - 1,
        );
      }
      out += String.fromCharCode(code);
    }
  }

  /** Parse one escape sequence following a consumed backslash. */
  private parseEscape(): string {
    const escStart = this.pos - 1;
    const code = this.next();
    switch (code) {
      case 0x22: // \"
        return '"';
      case 0x5c: // \\
        return "\\";
      case 0x2f: // \/
        return "/";
      case 0x62: // \b
        return "\b";
      case 0x66: // \f
        return "\f";
      case 0x6e: // \n
        return "\n";
      case 0x72: // \r
        return "\r";
      case 0x74: // \t
        return "\t";
      case 0x75: // \u
        return String.fromCharCode(this.parseHex4(escStart));
      default:
        throw new ParseAbort(
          `invalid escape at position ${escStart}`,
          escStart,
        );
    }
  }

  /**
   * Read exactly four hex digits and return the resulting code unit value.
   *
   * The code unit is returned as-is (lone surrogates included); surrogate
   * pairing is naturally reconstructed later because a subsequent `\uXXXX`
   * simply appends its own code unit, forming a valid JS surrogate pair.
   */
  private parseHex4(escStart: number): number {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      const digit = this.hexDigit(this.next());
      if (digit === -1) {
        throw new ParseAbort(
          `invalid \\u escape at position ${escStart}`,
          escStart,
        );
      }
      value = value * 16 + digit;
    }
    return value;
  }

  /** Decode one hex digit char code to its value, or `-1` if not a hex digit. */
  private hexDigit(code: number): number {
    if (code >= 0x30 && code <= 0x39) {
      return code - 0x30;
    }
    if (code >= 0x61 && code <= 0x66) {
      return code - 0x61 + 10;
    }
    if (code >= 0x41 && code <= 0x46) {
      return code - 0x41 + 10;
    }
    return -1;
  }

  /** Parse an array, rejecting leading/trailing commas. */
  private parseArray(): JsonNode {
    this.enter();
    this.pos += 1; // consume '['
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.peek() === 0x5d) {
      this.pos += 1; // empty array ']'
      this.leave();
      return { kind: "array", items };
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue());
      this.skipWhitespace();
      const code = this.peek();
      if (code === 0x2c) {
        this.pos += 1; // ',' then another element is required
        continue;
      }
      if (code === 0x5d) {
        this.pos += 1; // closing ']'
        this.leave();
        return { kind: "array", items };
      }
      throw new ParseAbort(this.unexpectedHere(), this.pos);
    }
  }

  /** Parse an object, rejecting leading/trailing commas and duplicate keys. */
  private parseObject(): JsonNode {
    this.enter();
    this.pos += 1; // consume '{'
    const members = new Map<string, JsonNode>();
    this.skipWhitespace();
    if (this.peek() === 0x7d) {
      this.pos += 1; // empty object '}'
      this.leave();
      return { kind: "object", members };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== 0x22) {
        throw new ParseAbort(
          `expected object key at position ${this.pos}`,
          this.pos,
        );
      }
      const keyStart = this.pos;
      const key = this.parseString();
      if (members.has(key)) {
        throw new ParseAbort(`duplicate object key ${JSON.stringify(key)}`, keyStart);
      }
      this.skipWhitespace();
      if (this.peek() !== 0x3a) {
        throw new ParseAbort(`expected ':' at position ${this.pos}`, this.pos);
      }
      this.pos += 1; // consume ':'
      this.skipWhitespace();
      members.set(key, this.parseValue());
      this.skipWhitespace();
      const code = this.peek();
      if (code === 0x2c) {
        this.pos += 1; // ',' then another member is required
        continue;
      }
      if (code === 0x7d) {
        this.pos += 1; // closing '}'
        this.leave();
        return { kind: "object", members };
      }
      throw new ParseAbort(this.unexpectedHere(), this.pos);
    }
  }

  /** Descend one structural level, guarding against pathological nesting. */
  private enter(): void {
    this.depth += 1;
    if (this.depth > JSON_MAX_STRUCTURAL_DEPTH) {
      throw new ParseAbort(
        `maximum structural depth ${JSON_MAX_STRUCTURAL_DEPTH} exceeded`,
        this.pos,
      );
    }
  }

  /** Ascend one structural level. */
  private leave(): void {
    this.depth -= 1;
  }

  /** Build an "unexpected character" message anchored at the cursor. */
  private unexpectedHere(): string {
    if (this.pos >= this.text.length) {
      return "unexpected end of input";
    }
    // Safe: bounded by the length check above.
    const ch = this.text[this.pos] as string;
    return `unexpected character '${ch}' at position ${this.pos}`;
  }
}

/**
 * Parse exactly one JSON value under the strict RFC 8259 subset grammar.
 *
 * Never throws for malformed input: any grammar violation, structural error,
 * duplicate key, or over-deep nesting is reported as
 * `{ ok: false, error }`. Only truly unexpected internal faults would
 * propagate.
 *
 * @param text - The complete JSON document text.
 * @returns A success result carrying the root {@link JsonNode}, or a failure
 *          result carrying a {@link JsonParseError}.
 */
export function parseJson(text: string): JsonParseResult {
  try {
    const node = new Parser(text).parseDocument();
    return { ok: true, node };
  } catch (err) {
    if (err instanceof ParseAbort) {
      return {
        ok: false,
        error: { message: err.detail, position: err.position },
      };
    }
    throw err;
  }
}
