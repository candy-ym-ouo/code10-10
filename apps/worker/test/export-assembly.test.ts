import { describe, expect, it } from "vitest";
import { buildHead, buildSuffix, serializeSessionsChunk } from "../src/lib/export.js";

const header = {
  id: "user-1",
  email: "a@example.com",
  displayName: "Alice",
  defaultInstrument: null,
  timezone: "Asia/Shanghai",
  locale: "zh-CN",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const session = (id: string) => ({
  id,
  userId: "user-1",
  title: `Session ${id}`,
  instrument: "piano",
  focus: null,
  location: null,
  notes: null,
  startedAt: new Date("2026-02-01T00:00:00.000Z"),
  actualDurationMs: 600_000n,
  status: "COMPLETED",
  completedAt: null,
  archivedAt: null,
  version: 1,
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
  mediaAssets: [],
  annotations: [],
  goals: [],
  review: null,
});

describe("json export assembly", () => {
  it("produces valid JSON when assembled across batches", () => {
    const batches = [[session("a"), session("b")], [session("c")]];
    let emitted = 0;
    let output = buildHead("json", header, { from: null, to: null });
    for (const batch of batches) {
      output += serializeSessionsChunk("json", batch as never, emitted);
      emitted += batch.length;
    }
    output += buildSuffix("json", emitted);

    const parsed = JSON.parse(output) as { practiceSessions: Array<{ id: string }> };
    expect(parsed.practiceSessions.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("produces a valid empty array when there are no sessions", () => {
    const output = buildHead("json", header, { from: null, to: null }) + buildSuffix("json", 0);
    const parsed = JSON.parse(output) as { practiceSessions: unknown[] };
    expect(parsed.practiceSessions).toEqual([]);
  });
});

describe("csv export assembly", () => {
  it("starts with the header row and quotes fields", () => {
    const head = buildHead("csv", header, { from: null, to: null });
    expect(head.startsWith('"recordType","id","sessionId","data"')).toBe(true);
    const chunk = serializeSessionsChunk("csv", [session("a")] as never, 0);
    expect(chunk).toContain('"session"');
    expect(buildSuffix("csv", 1)).toBe("");
  });
});
