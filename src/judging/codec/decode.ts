/**
 * Canonical decoder: strict JSON tree to {@link CanonicalValue}.
 *
 * {@link buildValue} validates a parsed {@link JsonNode} against the normative
 * value model before any application code sees it. It enforces, per tag: the
 * exact allowed field set (missing or extra fields are rejected), leaf grammars
 * (float/decimal/int/date/time/uuid/base64url/path), canonical ordering and
 * uniqueness of `set`/`frozenset` items and `dict` keys, and the structural
 * rules of the adapter tags (`ListNode` cycle bounds, `TreeNode` reachability
 * and trailing-null removal). Depth and node counts are metered against the
 * shared {@link Budget}.
 *
 * On any violation it throws {@link CanonicalValidationError}; the codec catches
 * that and reports a decode failure, so the public decode entry never throws.
 */

import type {
  CanonicalValue,
  DictEntry,
  NumericLeaf,
  RecordField,
} from "../value/model.js";
import type { JsonNode } from "./json.js";
import type { Budget } from "./limits.js";
import { CanonicalValidationError } from "./errors.js";
import { canonicalStringOf } from "./encode.js";
import {
  decodeBase64Url,
  isCanonicalFloat,
  isCanonicalIntString,
  isCanonicalRelativePath,
  isValidDate,
  isValidDatetimeText,
  isValidDecimalLiteral,
  isValidOffsetMinutes,
  isValidTimeOfDay,
  isValidUuid,
} from "./leaf-grammar.js";
import { compareUtf8, hasLoneSurrogate } from "./utf8.js";

/** Edge of the IEEE-754 exact-integer range (`2^53 - 1`). */
const MAX_SAFE_INT = 9_007_199_254_740_991n;

/**
 * Build a validated canonical value from a parsed JSON tree.
 *
 * @param node - The root JSON node produced by the strict parser.
 * @param budget - Depth/node accountant for this decode traversal.
 * @returns The validated canonical value.
 * @throws {CanonicalValidationError} If the tree is not a canonical value.
 */
export function buildValue(node: JsonNode, budget: Budget): CanonicalValue {
  return build(node, budget, "$");
}

/** Recursive worker that validates and constructs one node. */
function build(node: JsonNode, budget: Budget, path: string): CanonicalValue {
  budget.countNode();
  const members = asObject(node, path);
  const tag = tagOf(members, path);
  switch (tag) {
    case "null":
      fields(members, path, ["tag"]);
      return { tag: "null" };
    case "bool":
      fields(members, path, ["tag", "value"]);
      return { tag: "bool", value: boolOf(req(members, "value", path), path) };
    case "int":
      fields(members, path, ["tag", "value"]);
      return { tag: "int", value: intOf(req(members, "value", path), path) };
    case "float": {
      fields(members, path, ["tag", "value", "negativeZero"]);
      const value = rawStringOf(req(members, "value", path), path);
      const negativeZero = boolOf(req(members, "negativeZero", path), path);
      if (!isCanonicalFloat(value, negativeZero)) {
        throw new CanonicalValidationError("non-canonical float", path);
      }
      return { tag: "float", value, negativeZero };
    }
    case "decimal": {
      fields(members, path, ["tag", "value"]);
      const value = rawStringOf(req(members, "value", path), path);
      if (!isValidDecimalLiteral(value)) {
        throw new CanonicalValidationError("invalid decimal literal", path);
      }
      return { tag: "decimal", value };
    }
    case "complex": {
      fields(members, path, ["tag", "real", "imag"]);
      return {
        tag: "complex",
        real: leafOf(req(members, "real", path), budget, `${path}.real`),
        imag: leafOf(req(members, "imag", path), budget, `${path}.imag`),
      };
    }
    case "str": {
      fields(members, path, ["tag", "value"]);
      return { tag: "str", value: strOf(req(members, "value", path), path) };
    }
    case "list":
    case "tuple": {
      fields(members, path, ["tag", "items"]);
      const items = buildItems(req(members, "items", path), budget, path);
      return { tag, items };
    }
    case "set":
    case "frozenset": {
      fields(members, path, ["tag", "items"]);
      const items = buildItems(req(members, "items", path), budget, path);
      assertSortedUnique(
        items.map((it) => canonicalStringOf(it)),
        tag,
        path,
      );
      return { tag, items };
    }
    case "dict":
      return buildDict(members, budget, path);
    case "bytes":
      return buildBytes(members, path);
    case "date": {
      fields(members, path, ["tag", "value"]);
      const value = rawStringOf(req(members, "value", path), path);
      if (!isValidDate(value)) {
        throw new CanonicalValidationError("invalid date", path);
      }
      return { tag: "date", value };
    }
    case "time":
      return buildTime(members, path);
    case "datetime":
      return buildDatetime(members, path);
    case "uuid": {
      fields(members, path, ["tag", "value"]);
      const value = rawStringOf(req(members, "value", path), path);
      if (!isValidUuid(value)) {
        throw new CanonicalValidationError("invalid uuid", path);
      }
      return { tag: "uuid", value };
    }
    case "path":
      return buildPath(members, path);
    case "enum":
      return buildEnum(members, budget, path);
    case "record":
      return buildRecord(members, budget, path);
    case "exception":
      return buildException(members, budget, path);
    case "ListNode":
      return buildListNode(members, budget, path);
    case "TreeNode":
      return buildTreeNode(members, budget, path);
    case "ClassTrace":
      return buildClassTrace(members, budget, path);
    default:
      throw new CanonicalValidationError(
        `unknown tag ${JSON.stringify(tag)}`,
        path,
      );
  }
}

// --- structural helpers -----------------------------------------------------

/** Narrow a node to an object's member map, or reject. */
function asObject(node: JsonNode, path: string): ReadonlyMap<string, JsonNode> {
  if (node.kind !== "object") {
    throw new CanonicalValidationError("expected a tagged object", path);
  }
  return node.members;
}

/** Read the mandatory string `tag` discriminant. */
function tagOf(members: ReadonlyMap<string, JsonNode>, path: string): string {
  const node = members.get("tag");
  if (node === undefined || node.kind !== "string") {
    throw new CanonicalValidationError("missing or non-string tag", path);
  }
  return node.value;
}

/** Reject any member outside `allowed`, and any missing required member. */
function fields(
  members: ReadonlyMap<string, JsonNode>,
  path: string,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of members.keys()) {
    if (!allowed.includes(key) && !optional.includes(key)) {
      throw new CanonicalValidationError(
        `forbidden field ${JSON.stringify(key)}`,
        path,
      );
    }
  }
  for (const key of allowed) {
    if (!members.has(key)) {
      throw new CanonicalValidationError(
        `missing field ${JSON.stringify(key)}`,
        path,
      );
    }
  }
}

/** Fetch a required member node. */
function req(
  members: ReadonlyMap<string, JsonNode>,
  key: string,
  path: string,
): JsonNode {
  const node = members.get(key);
  if (node === undefined) {
    throw new CanonicalValidationError(
      `missing field ${JSON.stringify(key)}`,
      path,
    );
  }
  return node;
}

/** Require an array node and return its items. */
function arrOf(node: JsonNode, path: string): readonly JsonNode[] {
  if (node.kind !== "array") {
    throw new CanonicalValidationError("expected an array", path);
  }
  return node.items;
}

/** Require a boolean node. */
function boolOf(node: JsonNode, path: string): boolean {
  if (node.kind !== "bool") {
    throw new CanonicalValidationError("expected a boolean", path);
  }
  return node.value;
}

/** Require a string node whose text is free of lone surrogates. */
function strOf(node: JsonNode, path: string): string {
  if (node.kind !== "string") {
    throw new CanonicalValidationError("expected a string", path);
  }
  if (hasLoneSurrogate(node.value)) {
    throw new CanonicalValidationError("string contains a lone surrogate", path);
  }
  return node.value;
}

/**
 * Require a string node without the surrogate check.
 *
 * Used for leaf grammars (float/decimal/date/uuid/...) whose own validator
 * already constrains the character set to a surrogate-free subset.
 */
function rawStringOf(node: JsonNode, path: string): string {
  if (node.kind !== "string") {
    throw new CanonicalValidationError("expected a string", path);
  }
  return node.value;
}

/** Require a non-empty string (declaration identity / method names). */
function nonEmptyStrOf(node: JsonNode, path: string): string {
  const value = strOf(node, path);
  if (value.length === 0) {
    throw new CanonicalValidationError("expected a non-empty string", path);
  }
  return value;
}

/**
 * Decode an `int` payload.
 *
 * Canonical form is a bare JSON number inside the safe-integer range and a
 * decimal string outside it; the mismatched form is rejected so each integer
 * has exactly one representation.
 */
function intOf(node: JsonNode, path: string): bigint {
  if (node.kind === "number") {
    if (!isCanonicalIntString(node.raw)) {
      throw new CanonicalValidationError("int number must be an integer", path);
    }
    const value = BigInt(node.raw);
    if (value < -MAX_SAFE_INT || value > MAX_SAFE_INT) {
      throw new CanonicalValidationError(
        "out-of-range int must be a decimal string",
        path,
      );
    }
    return value;
  }
  if (node.kind === "string") {
    if (!isCanonicalIntString(node.value)) {
      throw new CanonicalValidationError("invalid int string", path);
    }
    const value = BigInt(node.value);
    if (value >= -MAX_SAFE_INT && value <= MAX_SAFE_INT) {
      throw new CanonicalValidationError(
        "safe-range int must be a JSON number",
        path,
      );
    }
    return value;
  }
  throw new CanonicalValidationError("expected an int number or string", path);
}

/** Build a numeric leaf, rejecting any non-numeric tag. */
function leafOf(node: JsonNode, budget: Budget, path: string): NumericLeaf {
  const value = build(node, budget, path);
  if (value.tag !== "int" && value.tag !== "float" && value.tag !== "decimal") {
    throw new CanonicalValidationError("expected a numeric leaf", path);
  }
  return value;
}

/** Build the elements of a sequence/set under a depth level. */
function buildItems(
  node: JsonNode,
  budget: Budget,
  path: string,
): CanonicalValue[] {
  const items = arrOf(node, path);
  budget.enter();
  const built = items.map((item, i) => build(item, budget, `${path}.items[${i}]`));
  budget.leave();
  return built;
}

/** Assert an array of encoded strings is strictly ascending (sorted + unique). */
function assertSortedUnique(
  encoded: readonly string[],
  label: string,
  path: string,
): void {
  for (let i = 1; i < encoded.length; i += 1) {
    const cmp = compareUtf8(encoded[i - 1] as string, encoded[i] as string);
    if (cmp > 0) {
      throw new CanonicalValidationError(`${label} items are not sorted`, path);
    }
    if (cmp === 0) {
      throw new CanonicalValidationError(`duplicate ${label} member`, path);
    }
  }
}

// --- per-tag builders -------------------------------------------------------

/** Build a `dict`: entries sorted by canonical key bytes, keys unique. */
function buildDict(
  members: ReadonlyMap<string, JsonNode>,
  budget: Budget,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "entries"]);
  const rawEntries = arrOf(req(members, "entries", path), path);
  budget.enter();
  const entries: DictEntry[] = rawEntries.map((entryNode, i) => {
    const entry = asObject(entryNode, `${path}.entries[${i}]`);
    fields(entry, `${path}.entries[${i}]`, ["key", "value"]);
    return {
      key: build(req(entry, "key", `${path}.entries[${i}]`), budget, `${path}.entries[${i}].key`),
      value: build(
        req(entry, "value", `${path}.entries[${i}]`),
        budget,
        `${path}.entries[${i}].value`,
      ),
    };
  });
  budget.leave();
  assertSortedUnique(
    entries.map((e) => canonicalStringOf(e.key)),
    "dict",
    path,
  );
  return { tag: "dict", entries };
}

/** Build a `bytes` value, validating canonical unpadded base64url. */
function buildBytes(
  members: ReadonlyMap<string, JsonNode>,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "encoding", "value"]);
  const encoding = rawStringOf(req(members, "encoding", path), path);
  if (encoding !== "base64url") {
    throw new CanonicalValidationError("unsupported bytes encoding", path);
  }
  const value = rawStringOf(req(members, "value", path), path);
  if (decodeBase64Url(value) === null) {
    throw new CanonicalValidationError("invalid base64url", path);
  }
  return { tag: "bytes", encoding: "base64url", value };
}

/** Build a `time` value with an optional aware offset. */
function buildTime(
  members: ReadonlyMap<string, JsonNode>,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "value", "offsetMinutes", "fold"]);
  const value = rawStringOf(req(members, "value", path), path);
  if (!isValidTimeOfDay(value)) {
    throw new CanonicalValidationError("invalid time", path);
  }
  return {
    tag: "time",
    value,
    offsetMinutes: offsetOf(req(members, "offsetMinutes", path), path, true),
    fold: foldOf(req(members, "fold", path), path),
  };
}

/** Build a `datetime` value with a required offset. */
function buildDatetime(
  members: ReadonlyMap<string, JsonNode>,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "value", "offsetMinutes", "fold"]);
  const value = rawStringOf(req(members, "value", path), path);
  if (!isValidDatetimeText(value)) {
    throw new CanonicalValidationError("invalid datetime", path);
  }
  const offset = offsetOf(req(members, "offsetMinutes", path), path, false);
  if (offset === null) {
    throw new CanonicalValidationError("datetime requires an offset", path);
  }
  return {
    tag: "datetime",
    value,
    offsetMinutes: offset,
    fold: foldOf(req(members, "fold", path), path),
  };
}

/** Build a `path` value; absolute paths are rejected. */
function buildPath(
  members: ReadonlyMap<string, JsonNode>,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "value", "flavor"]);
  const flavor = rawStringOf(req(members, "flavor", path), path);
  if (flavor !== "posix" && flavor !== "windows") {
    throw new CanonicalValidationError("invalid path flavor", path);
  }
  const value = rawStringOf(req(members, "value", path), path);
  if (!isCanonicalRelativePath(value, flavor)) {
    throw new CanonicalValidationError("invalid or absolute path", path);
  }
  return { tag: "path", value, flavor };
}

/** Build an `enum` value. */
function buildEnum(
  members: ReadonlyMap<string, JsonNode>,
  budget: Budget,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "type", "member", "value"]);
  budget.enter();
  const value = build(req(members, "value", path), budget, `${path}.value`);
  budget.leave();
  return {
    tag: "enum",
    type: nonEmptyStrOf(req(members, "type", path), `${path}.type`),
    member: nonEmptyStrOf(req(members, "member", path), `${path}.member`),
    value,
  };
}

/** Build a `record` with declaration-ordered, uniquely named fields. */
function buildRecord(
  members: ReadonlyMap<string, JsonNode>,
  budget: Budget,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "type", "name", "fields"]);
  const type = rawStringOf(req(members, "type", path), path);
  if (type !== "dataclass" && type !== "namedtuple") {
    throw new CanonicalValidationError("invalid record type", path);
  }
  const name = nonEmptyStrOf(req(members, "name", path), `${path}.name`);
  const rawFields = arrOf(req(members, "fields", path), path);
  const seen = new Set<string>();
  budget.enter();
  const fieldList: RecordField[] = rawFields.map((fieldNode, i) => {
    const fieldPath = `${path}.fields[${i}]`;
    const field = asObject(fieldNode, fieldPath);
    fields(field, fieldPath, ["name", "value"]);
    const fieldName = strOf(req(field, "name", fieldPath), fieldPath);
    if (seen.has(fieldName)) {
      throw new CanonicalValidationError("duplicate record field name", fieldPath);
    }
    seen.add(fieldName);
    return {
      name: fieldName,
      value: build(req(field, "value", fieldPath), budget, `${fieldPath}.value`),
    };
  });
  budget.leave();
  return { tag: "record", type, name, fields: fieldList };
}

/** Build an `exception` value with optional tagged details. */
function buildException(
  members: ReadonlyMap<string, JsonNode>,
  budget: Budget,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "type", "message", "details"]);
  const detailsNode = req(members, "details", path);
  budget.enter();
  const details =
    detailsNode.kind === "null"
      ? null
      : build(detailsNode, budget, `${path}.details`);
  budget.leave();
  return {
    tag: "exception",
    type: nonEmptyStrOf(req(members, "type", path), `${path}.type`),
    message: strOf(req(members, "message", path), `${path}.message`),
    details,
  };
}

/** Build a `ListNode`; `cycleIndex` must index within `values`. */
function buildListNode(
  members: ReadonlyMap<string, JsonNode>,
  budget: Budget,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "values", "cycleIndex"]);
  const rawValues = arrOf(req(members, "values", path), path);
  budget.enter();
  const values = rawValues.map((v, i) =>
    build(v, budget, `${path}.values[${i}]`),
  );
  budget.leave();
  const cycleIndex = nullableIndexOf(
    req(members, "cycleIndex", path),
    values.length,
    path,
  );
  return { tag: "ListNode", values, cycleIndex };
}

/** Build a `TreeNode`; reject trailing nulls and unreachable nodes. */
function buildTreeNode(
  members: ReadonlyMap<string, JsonNode>,
  budget: Budget,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "values"]);
  const rawValues = arrOf(req(members, "values", path), path);
  if (rawValues.length > 0 && rawValues[rawValues.length - 1]?.kind === "null") {
    throw new CanonicalValidationError(
      "TreeNode has trailing nulls (non-canonical)",
      path,
    );
  }
  // A null (absent) slot may not have a non-null descendant.
  for (let i = 0; i < rawValues.length; i += 1) {
    if (rawValues[i]?.kind === "null") {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (
        (left < rawValues.length && rawValues[left]?.kind !== "null") ||
        (right < rawValues.length && rawValues[right]?.kind !== "null")
      ) {
        throw new CanonicalValidationError("unreachable TreeNode node", path);
      }
    }
  }
  budget.enter();
  const values = rawValues.map((slot, i) =>
    slot.kind === "null" ? null : build(slot, budget, `${path}.values[${i}]`),
  );
  budget.leave();
  return { tag: "TreeNode", values };
}

/** Build a `ClassTrace`: constructor args followed by ordered operations. */
function buildClassTrace(
  members: ReadonlyMap<string, JsonNode>,
  budget: Budget,
  path: string,
): CanonicalValue {
  fields(members, path, ["tag", "className", "constructor", "operations"]);
  const className = nonEmptyStrOf(
    req(members, "className", path),
    `${path}.className`,
  );
  const rawCtor = arrOf(req(members, "constructor", path), path);
  const rawOps = arrOf(req(members, "operations", path), path);
  budget.enter();
  const ctor = rawCtor.map((v, i) =>
    build(v, budget, `${path}.constructor[${i}]`),
  );
  const operations = rawOps.map((opNode, i) => {
    const opPath = `${path}.operations[${i}]`;
    const op = asObject(opNode, opPath);
    fields(op, opPath, ["method", "args"], ["expected"]);
    const method = nonEmptyStrOf(req(op, "method", opPath), `${opPath}.method`);
    const args = arrOf(req(op, "args", opPath), opPath).map((a, j) =>
      build(a, budget, `${opPath}.args[${j}]`),
    );
    const expectedNode = op.get("expected");
    if (expectedNode === undefined) {
      return { method, args };
    }
    return {
      method,
      args,
      expected: build(expectedNode, budget, `${opPath}.expected`),
    };
  });
  budget.leave();
  return { tag: "ClassTrace", className, constructor: ctor, operations };
}

// --- numeric field helpers --------------------------------------------------

/** Read a `fold` field, which must be the JSON number `0` or `1`. */
function foldOf(node: JsonNode, path: string): 0 | 1 {
  if (node.kind === "number" && node.raw === "0") {
    return 0;
  }
  if (node.kind === "number" && node.raw === "1") {
    return 1;
  }
  throw new CanonicalValidationError("fold must be 0 or 1", path);
}

/** Read an `offsetMinutes` field: an in-range integer, or null when allowed. */
function offsetOf(
  node: JsonNode,
  path: string,
  nullable: boolean,
): number | null {
  if (node.kind === "null") {
    if (!nullable) {
      throw new CanonicalValidationError("offsetMinutes must not be null", path);
    }
    return null;
  }
  if (node.kind !== "number" || !isCanonicalIntString(node.raw)) {
    throw new CanonicalValidationError("offsetMinutes must be an integer", path);
  }
  const value = Number(node.raw);
  if (!isValidOffsetMinutes(value)) {
    throw new CanonicalValidationError("offsetMinutes out of range", path);
  }
  return value;
}

/** Read a nullable non-negative index bounded by `length`. */
function nullableIndexOf(
  node: JsonNode,
  length: number,
  path: string,
): number | null {
  if (node.kind === "null") {
    return null;
  }
  if (node.kind !== "number" || !isCanonicalIntString(node.raw)) {
    throw new CanonicalValidationError("cycleIndex must be an integer", path);
  }
  const value = Number(node.raw);
  if (value < 0 || value >= length) {
    throw new CanonicalValidationError("cycleIndex out of range", path);
  }
  return value;
}
