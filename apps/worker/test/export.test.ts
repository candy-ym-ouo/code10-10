import { describe, expect, it } from "vitest";
import { type ExportCheckpoint, batchesToCsv, finalizeExport } from "../src/lib/export.js";

function checkpoint(format: string): ExportCheckpoint {
  return {
    version: 1,
    userId: "u-1",
    format,
    params: { from: null, to: null },
    profile: { id: "u-1", email: "a@example.com" },
    batches: [
      {
        session: { id: "s-1", title: "第一课", actualDurationMs: 600000 },
        media: [{ id: "m-1", status: "READY", durationMs: 600000 }],
        annotations: [{ id: "a-1", type: "RHYTHM", title: "抢拍" }],
        goals: [{ id: "g-1", title: "节拍器 80", status: "OPEN" }],
        review: { id: "r-1", nextFocus: "慢练" },
      },
    ],
  };
}

describe("batchesToCsv", () => {
  it("flattens sessions and related records with stable columns", () => {
    const csv = batchesToCsv(checkpoint("csv").batches);
    const lines = csv.split("\n");
    expect(lines[0]).toBe('"recordType","id","sessionId","data"');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('"session"');
    expect(lines[2]).toContain('"media"');
    expect(lines[3]).toContain('"annotation"');
    expect(lines[4]).toContain('"goal"');
  });

  it("escapes embedded quotes", () => {
    const csv = batchesToCsv([
      {
        session: { id: "s", title: '标题"引号"' },
        media: [],
        annotations: [],
        goals: [],
        review: null,
      },
    ]);
    // data 列先 JSON.stringify（引号变 \"），再做 CSV 转义（" 变 ""），最终为 \""
    expect(csv).toContain('标题\\""引号\\""');
  });
});

describe("finalizeExport", () => {
  it("builds json envelope with range and profile", () => {
    const output = finalizeExport(checkpoint("json"));
    expect(output.contentType).toBe("application/json; charset=utf-8");
    const parsed = JSON.parse(output.body) as { range: unknown; user: unknown; practiceSessions: unknown[] };
    expect(parsed.range).toEqual({ from: null, to: null });
    expect(parsed.user).toMatchObject({ email: "a@example.com" });
    expect(parsed.practiceSessions).toHaveLength(1);
  });

  it("uses csv content type for csv exports", () => {
    const output = finalizeExport(checkpoint("csv"));
    expect(output.contentType).toBe("text/csv; charset=utf-8");
    expect(output.body.startsWith('"recordType"')).toBe(true);
  });
});
