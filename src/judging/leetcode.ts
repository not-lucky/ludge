/** Plain LeetCode JSON <-> the internal execution value model.
 *
 * Case authors never write tagged protocol values. This module is the single
 * signature-directed boundary that turns strict parsed JSON into the internal
 * values carried by the process protocol.
 */
import type { Problem, LeetType } from "../infrastructure/problem.js";
import type { JsonNode } from "./codec/json.js";
import type { CanonicalValue } from "./value/model.js";

export class LeetCodeValueError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LeetCodeValueError";
  }
}

export function decodeFunctionCase(
  input: JsonNode,
  expected: JsonNode,
  problem: Extract<Problem, { readonly kind: "function" }>,
): Readonly<{ input: CanonicalValue; expected: CanonicalValue }> {
  const args = array(input, "input");
  if (args.length !== problem.args.length) {
    throw new LeetCodeValueError(
      `input expects ${problem.args.length} arguments, got ${args.length}`,
    );
  }
  return {
    input: {
      tag: "tuple",
      items: args.map((node, index) =>
        decode(node, problem.args[index]!, `input[${index}]`),
      ),
    },
    expected: decode(expected, problem.returns, "expected", true),
  };
}

export function decodeClassCase(
  input: JsonNode,
  expected: JsonNode,
  problem: Extract<Problem, { readonly kind: "class" }>,
): Readonly<{ input: CanonicalValue; expected: CanonicalValue }> {
  const outer = array(input, "input");
  if (outer.length !== 2)
    throw new LeetCodeValueError("class input must be [operations, arguments]");
  const operations = array(outer[0]!, "input[0]");
  const arguments_ = array(outer[1]!, "input[1]");
  const returns = array(expected, "expected");
  if (operations.length === 0)
    throw new LeetCodeValueError("class input must include the constructor");
  if (
    operations.length !== arguments_.length ||
    operations.length !== returns.length
  ) {
    throw new LeetCodeValueError(
      "operations, arguments, and expected must have equal lengths",
    );
  }
  const constructorName = string(operations[0]!, "input[0][0]");
  if (constructorName !== problem.className) {
    throw new LeetCodeValueError(
      `first operation must be ${JSON.stringify(problem.className)}`,
    );
  }
  if (returns[0]!.kind !== "null")
    throw new LeetCodeValueError(
      "expected[0] must be null for the constructor",
    );
  const constructor = decodeArguments(
    arguments_[0]!,
    problem.constructor,
    "input[1][0]",
  );
  const traceOperations: { method: string; args: readonly CanonicalValue[] }[] =
    [];
  const output: CanonicalValue[] = [{ tag: "null" }];
  for (let index = 1; index < operations.length; index += 1) {
    const name = string(operations[index]!, `input[0][${index}]`);
    const method = problem.methods[name];
    if (method === undefined)
      throw new LeetCodeValueError(`unknown method ${JSON.stringify(name)}`);
    traceOperations.push({
      method: name,
      args: decodeArguments(
        arguments_[index]!,
        method.args,
        `input[1][${index}]`,
      ),
    });
    output.push(
      decode(returns[index]!, method.returns, `expected[${index}]`, true),
    );
  }
  return {
    input: {
      tag: "ClassTrace",
      className: problem.className,
      constructor,
      operations: traceOperations,
    },
    expected: { tag: "list", items: output },
  };
}

/** Whether a protocol value belongs to the closed LeetCode value set. Tuples
 * are transport-only positional arguments and are permitted for generator
 * output/internal requests, but not required as a solution result. */
export function isLeetCodeValue(value: CanonicalValue): boolean {
  switch (value.tag) {
    case "null":
    case "bool":
    case "int":
    case "float":
    case "str":
      return true;
    case "list":
    case "tuple":
      return value.items.every(isLeetCodeValue);
    case "ListNode":
      return value.cycleIndex === null && value.values.every(isLeetCodeValue);
    case "TreeNode":
      return value.values.every(
        (item) => item === null || isLeetCodeValue(item),
      );
    default:
      return false;
  }
}

export function decodeLeetCodeCase(
  input: JsonNode,
  expected: JsonNode,
  problem: Problem,
): Readonly<{ input: CanonicalValue; expected: CanonicalValue }> {
  return problem.kind === "function"
    ? decodeFunctionCase(input, expected, problem)
    : decodeClassCase(input, expected, problem);
}

function decodeArguments(
  node: JsonNode,
  types: readonly LeetType[],
  path: string,
): readonly CanonicalValue[] {
  const values = array(node, path);
  if (values.length !== types.length)
    throw new LeetCodeValueError(
      `${path} expects ${types.length} arguments, got ${values.length}`,
    );
  return values.map((value, index) =>
    decode(value, types[index]!, `${path}[${index}]`),
  );
}

function decode(
  node: JsonNode,
  type: LeetType,
  path: string,
  topLevelReturn = false,
): CanonicalValue {
  switch (type.kind) {
    case "int":
      return { tag: "int", value: integer(node, path) };
    case "float":
      return {
        tag: "float",
        value: float(node, path),
        negativeZero:
          node.kind === "number" &&
          /^-0(?:\.0*)?(?:[eE][+-]?0+)?$/u.test(node.raw),
      };
    case "str":
      return { tag: "str", value: string(node, path) };
    case "bool":
      if (node.kind !== "bool") fail(path, "expected a boolean");
      return { tag: "bool", value: node.value };
    case "null":
      if (node.kind !== "null") fail(path, "expected null");
      return { tag: "null" };
    case "list":
      return {
        tag: "list",
        items: array(node, path).map((item, index) =>
          decode(item, type.item, `${path}[${index}]`),
        ),
      };
    case "ListNode": {
      if (node.kind === "null")
        return topLevelReturn
          ? { tag: "null" }
          : { tag: "ListNode", values: [], cycleIndex: null };
      const values = array(node, path).map((item, index) =>
        decode(item, type.item, `${path}[${index}]`),
      );
      return { tag: "ListNode", values, cycleIndex: null };
    }
    case "TreeNode": {
      if (node.kind === "null")
        return topLevelReturn
          ? { tag: "null" }
          : { tag: "TreeNode", values: [] };
      const slots = array(node, path).map((item, index) =>
        item.kind === "null"
          ? null
          : decode(item, type.item, `${path}[${index}]`),
      );
      validateTree(slots, path);
      while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
      return { tag: "TreeNode", values: slots };
    }
  }
}

function integer(node: JsonNode, path: string): bigint {
  const text =
    node.kind === "number"
      ? node.raw
      : node.kind === "string"
        ? node.value
        : undefined;
  if (text === undefined || !/^-?(?:0|[1-9][0-9]*)$/u.test(text))
    fail(path, "expected an integer number or decimal string");
  return BigInt(text!);
}
function float(node: JsonNode, path: string): string {
  if (
    node.kind !== "number" ||
    !/^-?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|(?:0|[1-9][0-9]*)[eE][+-]?[0-9]+)$/u.test(
      node.raw,
    )
  )
    fail(path, "expected a finite JSON number");
  const number = Number(node.raw);
  if (!Number.isFinite(number)) fail(path, "expected a finite JSON number");
  return Object.is(number, -0) ? "0" : String(number);
}
function string(node: JsonNode, path: string): string {
  if (node.kind !== "string") fail(path, "expected a string");
  return node.value;
}
function array(node: JsonNode, path: string): readonly JsonNode[] {
  if (node.kind !== "array") fail(path, "expected an array");
  return node.items;
}
function validateTree(
  values: readonly (CanonicalValue | null)[],
  path: string,
): void {
  if (values.length === 0) return;
  if (values[0] === null) {
    if (values.some((value) => value !== null))
      fail(path, "a null tree root cannot have descendants");
    return;
  }
  // LeetCode's level-order representation consumes child slots only for real
  // parents: `[1, null, 2, 3]` is valid and means 3 is 2's left child.
  const parents: CanonicalValue[] = [values[0]!];
  let index = 1;
  while (parents.length > 0 && index < values.length) {
    parents.shift();
    for (
      let child = 0;
      child < 2 && index < values.length;
      child += 1, index += 1
    ) {
      const value = values[index]!;
      if (value !== null) parents.push(value);
    }
  }
  for (; index < values.length; index += 1) {
    if (values[index] !== null)
      fail(`${path}[${index}]`, "tree has an unreachable node");
  }
}
function fail(path: string, message: string): never {
  throw new LeetCodeValueError(`${path}: ${message}`);
}
