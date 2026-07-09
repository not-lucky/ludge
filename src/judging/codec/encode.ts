/**
 * Canonical encoder: {@link CanonicalValue} to canonical JSON text.
 *
 * The encoder is the authoritative definition of the `tagged-jsonl-v1` wire
 * form. It guarantees determinism: object keys are emitted in UTF-8 lexical
 * order, set/frozenset items and dict entries are sorted (and de-duplicated) by
 * canonical encoded bytes, and every leaf is validated against its normative
 * grammar before emission. Equal values therefore always produce byte-identical
 * output, which is what makes differential testing and byte-equality policies
 * meaningful.
 *
 * Encoding is strict: an invalid in-memory value (a non-canonical leaf, a
 * reference cycle, duplicate set/dict members, or an exceeded limit) throws
 * {@link CodecEncodeError} rather than emitting malformed bytes.
 */

import type {
  CanonicalValue,
  DictEntry,
  NumericLeaf,
} from "../value/model.js";
import { Budget, LimitExceededError } from "./limits.js";
import { CodecEncodeError } from "./errors.js";
import {
  decodeBase64Url,
  encodeBase64Url,
  isCanonicalFloat,
  isCanonicalRelativePath,
  isValidDate,
  isValidDatetimeText,
  isValidDecimalLiteral,
  isValidOffsetMinutes,
  isValidTimeOfDay,
  isValidUuid,
} from "./leaf-grammar.js";
import { compareUtf8, hasLoneSurrogate } from "./utf8.js";

/**
 * Largest integer magnitude that may be emitted as a bare JSON number.
 *
 * This is `2^53 - 1`, the edge of the IEEE-754 exact-integer range. Integers
 * outside `[-MAX_SAFE_INT, MAX_SAFE_INT]` are emitted as decimal strings so no
 * precision is lost when a lax reader parses the JSON with a native number.
 */
const MAX_SAFE_INT = 9_007_199_254_740_991n;

/**
 * Encode a canonical value to its canonical JSON text.
 *
 * @param value - The value to encode.
 * @param budget - Depth/node accountant for this encode traversal.
 * @returns The canonical JSON text (no trailing newline).
 * @throws {CodecEncodeError} If the value is not canonically encodable.
 */
export function encodeValue(value: CanonicalValue, budget: Budget): string {
  try {
    return encodeNode(value, budget, new Set<object>(), "$");
  } catch (err) {
    if (err instanceof LimitExceededError) {
      // Present limit violations uniformly as an encode failure.
      throw new CodecEncodeError(err.message);
    }
    throw err;
  }
}

/**
 * Encode a value using a throwaway budget.
 *
 * Used to obtain the canonical bytes of a sub-value for ordering/uniqueness
 * comparisons (sets, dict keys) without perturbing an in-progress budget.
 *
 * @param value - The value to encode.
 * @returns The canonical JSON text.
 */
export function canonicalStringOf(value: CanonicalValue): string {
  return encodeValue(value, new Budget());
}

/** Recursive worker; `seen` holds ancestor containers to detect cycles. */
function encodeNode(
  value: CanonicalValue,
  budget: Budget,
  seen: Set<object>,
  path: string,
): string {
  budget.countNode();
  switch (value.tag) {
    case "null":
      return '{"tag":"null"}';
    case "bool":
      return obj([["tag", '"bool"'], ["value", value.value ? "true" : "false"]]);
    case "int":
      return obj([["tag", '"int"'], ["value", encodeInt(value.value)]]);
    case "float":
      return encodeFloat(value.value, value.negativeZero, path);
    case "decimal":
      if (!isValidDecimalLiteral(value.value)) {
        throw new CodecEncodeError("invalid decimal literal", path);
      }
      return obj([["tag", '"decimal"'], ["value", jsonString(value.value)]]);
    case "complex":
      return obj([
        ["imag", encodeLeaf(value.imag, budget, seen, `${path}.imag`)],
        ["real", encodeLeaf(value.real, budget, seen, `${path}.real`)],
        ["tag", '"complex"'],
      ]);
    case "str":
      return obj([["tag", '"str"'], ["value", encodeStr(value.value, path)]]);
    case "list":
    case "tuple":
      return encodeSequence(value.tag, value.items, budget, seen, path);
    case "set":
    case "frozenset":
      return encodeSet(value.tag, value.items, budget, seen, path);
    case "dict":
      return encodeDict(value.entries, budget, seen, path);
    case "bytes":
      return encodeBytes(value.value, path);
    case "date":
      if (!isValidDate(value.value)) {
        throw new CodecEncodeError("invalid date", path);
      }
      return obj([["tag", '"date"'], ["value", jsonString(value.value)]]);
    case "time":
      return encodeTime(value.value, value.offsetMinutes, value.fold, path);
    case "datetime":
      return encodeDatetime(value.value, value.offsetMinutes, value.fold, path);
    case "uuid":
      if (!isValidUuid(value.value)) {
        throw new CodecEncodeError("invalid uuid", path);
      }
      return obj([["tag", '"uuid"'], ["value", jsonString(value.value)]]);
    case "path":
      if (!isCanonicalRelativePath(value.value, value.flavor)) {
        throw new CodecEncodeError("invalid or absolute path", path);
      }
      return obj([
        ["flavor", jsonString(value.flavor)],
        ["tag", '"path"'],
        ["value", jsonString(value.value)],
      ]);
    case "enum":
      return withContainer(value, seen, path, () =>
        obj([
          ["member", encodeStr(value.member, `${path}.member`)],
          ["tag", '"enum"'],
          ["type", encodeStr(value.type, `${path}.type`)],
          ["value", encodeNode(value.value, budget, seen, `${path}.value`)],
        ]),
      );
    case "record":
      return encodeRecord(value, budget, seen, path);
    case "exception":
      return encodeException(value, budget, seen, path);
    case "ListNode":
      return encodeListNode(value, budget, seen, path);
    case "TreeNode":
      return encodeTreeNode(value, budget, seen, path);
    case "ClassTrace":
      return encodeClassTrace(value, budget, seen, path);
  }
}

/** Encode a required numeric leaf, rejecting any non-numeric tag. */
function encodeLeaf(
  leaf: NumericLeaf,
  budget: Budget,
  seen: Set<object>,
  path: string,
): string {
  if (leaf.tag !== "int" && leaf.tag !== "float" && leaf.tag !== "decimal") {
    throw new CodecEncodeError("complex parts must be numeric leaves", path);
  }
  return encodeNode(leaf, budget, seen, path);
}

/** Emit a bigint as a bare JSON number when safe, else as a decimal string. */
function encodeInt(value: bigint): string {
  if (value >= -MAX_SAFE_INT && value <= MAX_SAFE_INT) {
    return value.toString();
  }
  return jsonString(value.toString());
}

/** Validate and emit a canonical float object. */
function encodeFloat(value: string, negativeZero: boolean, path: string): string {
  if (!isCanonicalFloat(value, negativeZero)) {
    throw new CodecEncodeError("non-canonical or non-finite float", path);
  }
  return obj([
    ["negativeZero", negativeZero ? "true" : "false"],
    ["tag", '"float"'],
    ["value", jsonString(value)],
  ]);
}

/** Validate and emit a canonical str value payload (rejecting lone surrogates). */
function encodeStr(value: string, path: string): string {
  if (hasLoneSurrogate(value)) {
    throw new CodecEncodeError("string contains a lone surrogate", path);
  }
  return jsonString(value);
}

/** Encode an ordered `list`/`tuple` whose element order is significant. */
function encodeSequence(
  tag: "list" | "tuple",
  items: readonly CanonicalValue[],
  budget: Budget,
  seen: Set<object>,
  path: string,
): string {
  return withContainer({ tag, items } as object, seen, path, () => {
    budget.enter();
    const parts = items.map((item, i) =>
      encodeNode(item, budget, seen, `${path}.items[${i}]`),
    );
    budget.leave();
    return obj([["items", `[${parts.join(",")}]`], ["tag", jsonString(tag)]]);
  });
}

/** Encode a `set`/`frozenset`: items sorted by encoded bytes and unique. */
function encodeSet(
  tag: "set" | "frozenset",
  items: readonly CanonicalValue[],
  budget: Budget,
  seen: Set<object>,
  path: string,
): string {
  return withContainer({ tag, items } as object, seen, path, () => {
    budget.enter();
    const encoded = items.map((item, i) =>
      encodeNode(item, budget, seen, `${path}.items[${i}]`),
    );
    budget.leave();
    encoded.sort(compareUtf8);
    for (let i = 1; i < encoded.length; i += 1) {
      if (compareUtf8(encoded[i - 1] as string, encoded[i] as string) === 0) {
        throw new CodecEncodeError(`duplicate ${tag} member`, path);
      }
    }
    return obj([["items", `[${encoded.join(",")}]`], ["tag", jsonString(tag)]]);
  });
}

/** Encode a `dict`: entries sorted by encoded key bytes, keys unique. */
function encodeDict(
  entries: readonly DictEntry[],
  budget: Budget,
  seen: Set<object>,
  path: string,
): string {
  return withContainer({ tag: "dict", entries } as object, seen, path, () => {
    budget.enter();
    const encoded = entries.map((entry, i) => {
      const key = encodeNode(entry.key, budget, seen, `${path}.entries[${i}].key`);
      const val = encodeNode(
        entry.value,
        budget,
        seen,
        `${path}.entries[${i}].value`,
      );
      return { key, entry: obj([["key", key], ["value", val]]) };
    });
    budget.leave();
    encoded.sort((a, b) => compareUtf8(a.key, b.key));
    for (let i = 1; i < encoded.length; i += 1) {
      const prev = encoded[i - 1];
      const cur = encoded[i];
      if (prev !== undefined && cur !== undefined && compareUtf8(prev.key, cur.key) === 0) {
        throw new CodecEncodeError("duplicate dict key", path);
      }
    }
    return obj([
      ["entries", `[${encoded.map((e) => e.entry).join(",")}]`],
      ["tag", '"dict"'],
    ]);
  });
}

/** Validate and emit a canonical bytes object. */
function encodeBytes(value: string, path: string): string {
  // Re-encoding what we decode guarantees canonical unpadded base64url output.
  return obj([
    ["encoding", '"base64url"'],
    ["tag", '"bytes"'],
    ["value", jsonString(normalizeBase64Url(value, path))],
  ]);
}

/** Ensure a bytes payload is canonical base64url; return it verbatim. */
function normalizeBase64Url(value: string, path: string): string {
  // A canonical value already holds canonical text; recompute defensively so a
  // corrupt in-memory payload cannot slip onto the wire.
  const bytes = decodeBase64Url(value);
  if (bytes === null || encodeBase64Url(bytes) !== value) {
    throw new CodecEncodeError("invalid base64url", path);
  }
  return value;
}

/** Validate and emit a canonical time object. */
function encodeTime(
  value: string,
  offsetMinutes: number | null,
  fold: 0 | 1,
  path: string,
): string {
  if (!isValidTimeOfDay(value)) {
    throw new CodecEncodeError("invalid time", path);
  }
  if (offsetMinutes !== null && !isValidOffsetMinutes(offsetMinutes)) {
    throw new CodecEncodeError("offsetMinutes out of range", path);
  }
  return obj([
    ["fold", String(fold)],
    ["offsetMinutes", offsetMinutes === null ? "null" : String(offsetMinutes)],
    ["tag", '"time"'],
    ["value", jsonString(value)],
  ]);
}

/** Validate and emit a canonical datetime object. */
function encodeDatetime(
  value: string,
  offsetMinutes: number,
  fold: 0 | 1,
  path: string,
): string {
  if (!isValidDatetimeText(value)) {
    throw new CodecEncodeError("invalid datetime", path);
  }
  if (!isValidOffsetMinutes(offsetMinutes)) {
    throw new CodecEncodeError("offsetMinutes out of range", path);
  }
  return obj([
    ["fold", String(fold)],
    ["offsetMinutes", String(offsetMinutes)],
    ["tag", '"datetime"'],
    ["value", jsonString(value)],
  ]);
}

/** Encode a `record` with declaration-ordered, uniquely named fields. */
function encodeRecord(
  value: Extract<CanonicalValue, { tag: "record" }>,
  budget: Budget,
  seen: Set<object>,
  path: string,
): string {
  return withContainer(value, seen, path, () => {
    budget.enter();
    const seenNames = new Set<string>();
    const fields = value.fields.map((field, i) => {
      if (seenNames.has(field.name)) {
        throw new CodecEncodeError("duplicate record field name", path);
      }
      seenNames.add(field.name);
      return obj([
        ["name", encodeStr(field.name, `${path}.fields[${i}].name`)],
        ["value", encodeNode(field.value, budget, seen, `${path}.fields[${i}].value`)],
      ]);
    });
    budget.leave();
    return obj([
      ["fields", `[${fields.join(",")}]`],
      ["name", encodeStr(value.name, `${path}.name`)],
      ["tag", '"record"'],
      ["type", jsonString(value.type)],
    ]);
  });
}

/** Encode an `exception` value: type, message, and optional tagged details. */
function encodeException(
  value: Extract<CanonicalValue, { tag: "exception" }>,
  budget: Budget,
  seen: Set<object>,
  path: string,
): string {
  return withContainer(value, seen, path, () => {
    const details =
      value.details === null
        ? "null"
        : encodeNode(value.details, budget, seen, `${path}.details`);
    return obj([
      ["details", details],
      ["message", encodeStr(value.message, `${path}.message`)],
      ["tag", '"exception"'],
      ["type", encodeStr(value.type, `${path}.type`)],
    ]);
  });
}

/** Encode a `ListNode` adapter value; `cycleIndex` must point within `values`. */
function encodeListNode(
  value: Extract<CanonicalValue, { tag: "ListNode" }>,
  budget: Budget,
  seen: Set<object>,
  path: string,
): string {
  return withContainer(value, seen, path, () => {
    budget.enter();
    const values = value.values.map((v, i) =>
      encodeNode(v, budget, seen, `${path}.values[${i}]`),
    );
    budget.leave();
    if (value.cycleIndex !== null) {
      if (
        !Number.isInteger(value.cycleIndex) ||
        value.cycleIndex < 0 ||
        value.cycleIndex >= value.values.length
      ) {
        throw new CodecEncodeError("cycleIndex out of range", path);
      }
    }
    return obj([
      ["cycleIndex", value.cycleIndex === null ? "null" : String(value.cycleIndex)],
      ["tag", '"ListNode"'],
      ["values", `[${values.join(",")}]`],
    ]);
  });
}

/** Encode a `TreeNode` adapter value, stripping trailing nulls canonically. */
function encodeTreeNode(
  value: Extract<CanonicalValue, { tag: "TreeNode" }>,
  budget: Budget,
  seen: Set<object>,
  path: string,
): string {
  return withContainer(value, seen, path, () => {
    // Strip trailing null slots so the canonical form is unique.
    const slots = value.values.slice();
    while (slots.length > 0 && slots[slots.length - 1] === null) {
      slots.pop();
    }
    // A null parent may not have a non-null descendant (unreachable node).
    for (let i = 0; i < slots.length; i += 1) {
      if (slots[i] === null) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        if (
          (left < slots.length && slots[left] !== null) ||
          (right < slots.length && slots[right] !== null)
        ) {
          throw new CodecEncodeError("unreachable TreeNode node", path);
        }
      }
    }
    budget.enter();
    const parts = slots.map((slot, i) =>
      slot === null ? "null" : encodeNode(slot, budget, seen, `${path}.values[${i}]`),
    );
    budget.leave();
    return obj([["tag", '"TreeNode"'], ["values", `[${parts.join(",")}]`]]);
  });
}

/** Encode a `ClassTrace` adapter value: constructor args then operations. */
function encodeClassTrace(
  value: Extract<CanonicalValue, { tag: "ClassTrace" }>,
  budget: Budget,
  seen: Set<object>,
  path: string,
): string {
  return withContainer(value, seen, path, () => {
    budget.enter();
    const ctor = value.constructor.map((v, i) =>
      encodeNode(v, budget, seen, `${path}.constructor[${i}]`),
    );
    const ops = value.operations.map((op, i) => {
      const args = op.args.map((a, j) =>
        encodeNode(a, budget, seen, `${path}.operations[${i}].args[${j}]`),
      );
      const pairs: [string, string][] = [
        ["args", `[${args.join(",")}]`],
        ["method", encodeStr(op.method, `${path}.operations[${i}].method`)],
      ];
      if (op.expected !== undefined) {
        pairs.push([
          "expected",
          encodeNode(op.expected, budget, seen, `${path}.operations[${i}].expected`),
        ]);
      }
      return obj(pairs);
    });
    budget.leave();
    return obj([
      ["className", encodeStr(value.className, `${path}.className`)],
      ["constructor", `[${ctor.join(",")}]`],
      ["operations", `[${ops.join(",")}]`],
      ["tag", '"ClassTrace"'],
    ]);
  });
}

/** Run `body` with `node` pushed on the cycle-detection path. */
function withContainer(
  node: object,
  seen: Set<object>,
  path: string,
  body: () => string,
): string {
  if (seen.has(node)) {
    throw new CodecEncodeError("reference cycle detected", path);
  }
  seen.add(node);
  try {
    return body();
  } finally {
    seen.delete(node);
  }
}

/**
 * Assemble a JSON object from `[key, encodedValue]` pairs with keys emitted in
 * UTF-8 lexical order. The value strings are already-encoded JSON fragments.
 */
function obj(pairs: readonly (readonly [string, string])[]): string {
  const sorted = pairs
    .slice()
    .sort((a, b) => compareUtf8(a[0], b[0]));
  return `{${sorted.map(([k, v]) => `${jsonString(k)}:${v}`).join(",")}}`;
}

/** Encode a JSON string leaf deterministically via the platform serializer. */
function jsonString(value: string): string {
  return JSON.stringify(value);
}
