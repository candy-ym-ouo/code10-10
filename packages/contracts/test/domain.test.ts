import { describe, expect, it } from "vitest";
import {
  calculateSessionDuration,
  canTransitionSession,
  describeMissingReview,
  exportParamsFingerprint,
  isExportCancellable,
  isExportReusable,
  isGoalProgressValid,
  nextBatchCursor,
  validateAnnotationRange,
} from "../src/index.js";

describe("session state machine", () => {
  it("allows the required completion transition", () => {
    expect(canTransitionSession("IN_REVIEW", "COMPLETED")).toBe(true);
    expect(canTransitionSession("DRAFT", "COMPLETED")).toBe(false);
  });
});

describe("annotation range", () => {
  it("rejects ranges under 100ms and outside media", () => {
    expect(validateAnnotationRange(100, 150, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(900, 1100, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(100, 250, 1000)).toEqual({ ok: true });
  });
});

describe("review completion", () => {
  it("returns every missing item instead of a generic failure", () => {
    expect(
      describeMissingReview({
        readyMediaCount: 0,
        annotationCount: 0,
        noIssues: false,
        nextFocus: "",
        openGoalCount: 0,
        newGoalCount: 0,
        progressUpdateCount: 0,
      }),
    ).toHaveLength(4);
  });
});

describe("goal values", () => {
  it("suggests achieved only when actual reaches target", () => {
    expect(isGoalProgressValid(90, 88)).toBe(true);
    expect(isGoalProgressValid(87, 88)).toBe(false);
  });

  it("sums only valid media durations", () => {
    expect(calculateSessionDuration([1000, null, 2500, -1])).toBe(3500);
  });
});

describe("export dedup fingerprint", () => {
  it("is stable across equivalent date encodings and changes with inputs", () => {
    const base = { userId: "u-1", format: "json" as const, from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
    const viaDate = exportParamsFingerprint({ ...base, from: new Date(base.from!), to: new Date(base.to!) });
    const viaString = exportParamsFingerprint(base);
    expect(viaDate).toBe(viaString);
    expect(viaDate).toMatch(/^[0-9a-f]{64}$/);
    expect(exportParamsFingerprint({ ...base, format: "csv" })).not.toBe(viaDate);
    expect(exportParamsFingerprint({ ...base, userId: "u-2" })).not.toBe(viaDate);
  });

  it("treats missing and empty ranges identically", () => {
    expect(exportParamsFingerprint({ userId: "u", format: "json" })).toBe(
      exportParamsFingerprint({ userId: "u", format: "json", from: null, to: "" }),
    );
  });
});

describe("export state machine", () => {
  it("only allows cancelling queued or running tasks", () => {
    expect(isExportCancellable("PENDING")).toBe(true);
    expect(isExportCancellable("PROCESSING")).toBe(true);
    expect(isExportCancellable("READY")).toBe(false);
    expect(isExportCancellable("FAILED")).toBe(false);
    expect(isExportCancellable("EXPIRED")).toBe(false);
    expect(isExportCancellable("CANCELLED")).toBe(false);
  });

  it("reuses active tasks and unexpired files only", () => {
    expect(isExportReusable("PROCESSING")).toBe(true);
    expect(isExportReusable("PENDING")).toBe(true);
    expect(isExportReusable("READY", new Date(Date.now() + 60_000))).toBe(true);
    expect(isExportReusable("READY", new Date(Date.now() - 60_000))).toBe(false);
    expect(isExportReusable("CANCELLED")).toBe(false);
  });

  it("advances the batch cursor by the last row id", () => {
    expect(nextBatchCursor([])).toBeNull();
    expect(nextBatchCursor([{ id: "a" }, { id: "b" }])).toBe("b");
  });
});
