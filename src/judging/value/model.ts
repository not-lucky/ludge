/**
 * Canonical tagged value model.
 *
 * {@link CanonicalValue} is the in-memory representation of the tagged value
 * model described in `docs/contracts/value-model-and-protocol.md`. Every value
 * is a discriminated object keyed on `tag`; the `tagged-jsonl-v1` codec (see
 * `../codec/`) is the sole bridge between this model and its normative JSON wire
 * shape.
 *
 * This module is pure data: it declares types only and imports nothing. It is
 * deliberately runtime-neutral so judging policy can reason about decoded values
 * without touching the wire format.
 *
 * Representation notes that differ from the wire JSON:
 * - `int` is a JavaScript `bigint`, so the model carries arbitrary-precision
 *   integers without loss; the codec chooses a JSON number or decimal string on
 *   the wire depending on the safe-integer range.
 * - `float` keeps the canonical decimal *text* plus an explicit `negativeZero`
 *   flag so `-0.0` survives round-trips; the value is never a binary `number`.
 * - `decimal` keeps the exact, un-normalized source text.
 */

/**
 * A finite numeric leaf: the only value tags permitted as the real/imaginary
 * parts of a {@link ComplexValue}. Non-finite floats are rejected by the codec.
 */
export type NumericLeaf = IntValue | FloatValue | DecimalValue;

/** The absence of a value. Carries no payload. */
export interface NullValue {
  readonly tag: "null";
}

/** A boolean. Distinct from {@link IntValue}: `true` is never `1`. */
export interface BoolValue {
  readonly tag: "bool";
  readonly value: boolean;
}

/**
 * An arbitrary-precision integer, held as a `bigint`.
 *
 * The codec emits a JSON number inside `-(2^53-1)..(2^53-1)` and a decimal
 * string outside it, but the model itself is range-agnostic.
 */
export interface IntValue {
  readonly tag: "int";
  readonly value: bigint;
}

/**
 * A finite IEEE-754 double represented by canonical decimal text.
 *
 * `value` follows the canonical `float` grammar (see `../codec/leaf-grammar.ts`);
 * `negativeZero` is `true` only for `-0.0`, in which case `value` is `"0"`. NaN
 * and Infinity are not representable and are rejected by the codec.
 */
export interface FloatValue {
  readonly tag: "float";
  readonly value: string;
  readonly negativeZero: boolean;
}

/**
 * An exact decimal, preserving the original, un-normalized decimal literal text
 * (sign, digits, fraction, and exponent). Never routed through binary float.
 */
export interface DecimalValue {
  readonly tag: "decimal";
  readonly value: string;
}

/** A complex number with separately tagged, finite real and imaginary leaves. */
export interface ComplexValue {
  readonly tag: "complex";
  readonly real: NumericLeaf;
  readonly imag: NumericLeaf;
}

/** A Unicode string. Lone UTF-16 surrogates are invalid and codec-rejected. */
export interface StrValue {
  readonly tag: "str";
  readonly value: string;
}

/** An ordered, heterogeneous sequence. Order is significant. */
export interface ListValue {
  readonly tag: "list";
  readonly items: readonly CanonicalValue[];
}

/** An ordered, immutable sequence (Python `tuple`). Order is significant. */
export interface TupleValue {
  readonly tag: "tuple";
  readonly items: readonly CanonicalValue[];
}

/**
 * A mutable set. On the wire, `items` are unique and sorted by canonical UTF-8
 * bytes; the codec enforces that ordering on decode and produces it on encode.
 */
export interface SetValue {
  readonly tag: "set";
  readonly items: readonly CanonicalValue[];
}

/** An immutable set. Same canonical ordering/uniqueness rules as {@link SetValue}. */
export interface FrozensetValue {
  readonly tag: "frozenset";
  readonly items: readonly CanonicalValue[];
}

/** A single `key -> value` association within a {@link DictValue}. */
export interface DictEntry {
  readonly key: CanonicalValue;
  readonly value: CanonicalValue;
}

/**
 * A mapping with arbitrary (non-string) tagged keys.
 *
 * On the wire, `entries` are sorted by canonical encoded key bytes and keys are
 * unique; keys are never coerced to strings.
 */
export interface DictValue {
  readonly tag: "dict";
  readonly entries: readonly DictEntry[];
}

/** Opaque binary data. `value` is unpadded URL-safe base64 (`base64url`). */
export interface BytesValue {
  readonly tag: "bytes";
  readonly encoding: "base64url";
  readonly value: string;
}

/** A calendar date, `YYYY-MM-DD`. */
export interface DateValue {
  readonly tag: "date";
  readonly value: string;
}

/**
 * A time of day, `HH:MM:SS[.ffffff]`.
 *
 * `offsetMinutes` is the UTC offset for an aware time and `null` for a naive
 * time; when present it lies in `-1439..1439`. `fold` disambiguates repeated
 * local times.
 */
export interface TimeValue {
  readonly tag: "time";
  readonly value: string;
  readonly offsetMinutes: number | null;
  readonly fold: 0 | 1;
}

/**
 * A timestamp, `YYYY-MM-DDTHH:MM:SS[.ffffff]`.
 *
 * `offsetMinutes` is required (zero for UTC) and lies in `-1439..1439`; `fold`
 * disambiguates repeated local times.
 */
export interface DatetimeValue {
  readonly tag: "datetime";
  readonly value: string;
  readonly offsetMinutes: number;
  readonly fold: 0 | 1;
}

/** A UUID in lowercase canonical `8-4-4-4-12` hexadecimal form. */
export interface UuidValue {
  readonly tag: "uuid";
  readonly value: string;
}

/**
 * A filesystem path. `value` is a normalized relative path; absolute paths are
 * rejected so host-absolute locations cannot leak. `flavor` names the path
 * dialect the normalization followed.
 */
export interface PathValue {
  readonly tag: "path";
  readonly value: string;
  readonly flavor: "posix" | "windows";
}

/**
 * An enum member. `type` is descriptive declaration metadata (never an import
 * instruction); `member` is the declared member name; `value` is its tagged
 * underlying value.
 */
export interface EnumValue {
  readonly tag: "enum";
  readonly type: string;
  readonly member: string;
  readonly value: CanonicalValue;
}

/** One named, tagged field of a {@link RecordValue}. */
export interface RecordField {
  readonly name: string;
  readonly value: CanonicalValue;
}

/**
 * A dataclass or namedtuple. `fields` are declaration-ordered with unique names
 * and tagged values; this is data, never executable class reconstruction.
 */
export interface RecordValue {
  readonly tag: "record";
  readonly type: "dataclass" | "namedtuple";
  readonly name: string;
  readonly fields: readonly RecordField[];
}

/**
 * A raised exception rendered as data: a stable `type` name, a bounded
 * `message`, and optional tagged `details`. Traceback/source text is never
 * carried and nothing here is executable.
 */
export interface ExceptionValue {
  readonly tag: "exception";
  readonly type: string;
  readonly message: string;
  readonly details: CanonicalValue | null;
}

/**
 * A singly linked list adapter value.
 *
 * `values` are the node payloads in order; `cycleIndex` is `null` for an acyclic
 * list or the index within `values` that the tail links back to. Cycles are only
 * valid when the problem's `classProtocol.allowCycles` is set (enforced by the
 * adapter, not the codec); the codec only checks the index is in range.
 */
export interface ListNodeValue {
  readonly tag: "ListNode";
  readonly values: readonly CanonicalValue[];
  readonly cycleIndex: number | null;
}

/**
 * A binary tree adapter value in level order.
 *
 * `values` holds each level-order slot, using `null` for an absent child.
 * Trailing nulls are removed canonically, and a `null` parent may not have a
 * non-null descendant (an unreachable node is invalid).
 */
export interface TreeNodeValue {
  readonly tag: "TreeNode";
  readonly values: readonly (CanonicalValue | null)[];
}

/** One operation applied during a {@link ClassTraceValue}. */
export interface ClassTraceOperation {
  readonly method: string;
  readonly args: readonly CanonicalValue[];
  /** Optional oracle-supplied expected return; data only, never executable. */
  readonly expected?: CanonicalValue;
}

/**
 * A stateful-class interaction trace.
 *
 * The Python harness constructs `className` with `constructor` args once, then
 * applies `operations` in order, emitting a return value after each. Mutation is
 * isolated per case.
 */
export interface ClassTraceValue {
  readonly tag: "ClassTrace";
  readonly className: string;
  readonly constructor: readonly CanonicalValue[];
  readonly operations: readonly ClassTraceOperation[];
}

/**
 * The complete tagged canonical value union: every core tag plus the registered
 * problem-adapter tags (`ListNode`, `TreeNode`, `ClassTrace`). These are not
 * arbitrary extension points; the set is closed and normative.
 */
export type CanonicalValue =
  | NullValue
  | BoolValue
  | IntValue
  | FloatValue
  | DecimalValue
  | ComplexValue
  | StrValue
  | ListValue
  | TupleValue
  | SetValue
  | FrozensetValue
  | DictValue
  | BytesValue
  | DateValue
  | TimeValue
  | DatetimeValue
  | UuidValue
  | PathValue
  | EnumValue
  | RecordValue
  | ExceptionValue
  | ListNodeValue
  | TreeNodeValue
  | ClassTraceValue;

/** The literal `tag` discriminant of every {@link CanonicalValue}. */
export type CanonicalTag = CanonicalValue["tag"];
