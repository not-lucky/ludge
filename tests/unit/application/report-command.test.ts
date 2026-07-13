import { describe, expect, it, vi } from "vitest";

import { executeReportCommand } from "../../../src/application/report-command.js";
import { makeRun } from "../../fixtures/persistence/index.js";

describe("report command", () => {
  it("streams a filtered JSON-safe summary through its read-only dependency", async () => {
    const list = vi.fn(async function* () {
      yield makeRun({ runId: "run-2" as never, status: "wrong_answer", seed: "7" });
      yield makeRun({ runId: "run-1" as never, status: "passed" });
    });

    const result = await executeReportCommand({ slug: "two-sum", since: "2026-07-20" }, { runs: { list } });

    expect(result).toMatchObject({
      status: "passed",
      result: { runCount: 2, statusCounts: { passed: 1, wrong_answer: 1 }, filters: { slug: "two-sum", since: "2026-07-20" } },
    });
    expect(list).toHaveBeenCalledWith({ slug: "two-sum", since: "2026-07-20T00:00:00.000Z" });
  });

  it("treats an empty read-only query as successful and never needs a writer", async () => {
    const list = vi.fn(async function* () {});

    const result = await executeReportCommand({}, { runs: { list } });

    expect(result).toEqual(expect.objectContaining({ status: "passed", result: expect.objectContaining({ runCount: 0, runs: [], statusCounts: {} }) }));
    expect(list).toHaveBeenCalledOnce();
  });

  it("rejects malformed filters before querying", async () => {
    const list = vi.fn(async function* () {});

    const result = await executeReportCommand({ since: "2025-02-29" }, { runs: { list } });

    expect(result).toMatchObject({ status: "invalid_input", diagnostics: [{ code: "invalid_report_filter" }] });
    expect(list).not.toHaveBeenCalled();
  });
});
