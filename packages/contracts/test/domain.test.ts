import { describe, expect, it } from "vitest";
import {
  calculateSessionDuration,
  canonicalExportParams,
  canTransitionSession,
  createExportSchema,
  describeMissingReview,
  isGoalProgressValid,
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

describe("export params fingerprint", () => {
  it("is stable across equivalent representations", () => {
    const date = new Date("2026-10-03T08:00:00.000Z");
    expect(canonicalExportParams({ format: "json", from: date, to: undefined })).toBe(
      canonicalExportParams({ format: "json", from: date.toISOString(), to: null }),
    );
  });

  it("distinguishes different formats and ranges", () => {
    expect(canonicalExportParams({ format: "json" })).not.toBe(canonicalExportParams({ format: "csv" }));
    expect(canonicalExportParams({ format: "json", from: new Date(0) })).not.toBe(
      canonicalExportParams({ format: "json", from: new Date(1) }),
    );
  });

  it("rejects a range whose end precedes start", () => {
    const result = createExportSchema.safeParse({
      format: "json",
      from: "2026-10-03T00:00:00Z",
      to: "2026-10-02T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});
