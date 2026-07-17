import { describe, expect, it } from "vitest";
import { firstNalUnitType } from "../src/video.js";

describe("H.264 packet classification", () => {
  it("identifies configuration, keyframe, and delta Annex-B units", () => {
    expect(firstNalUnitType(Uint8Array.from([0, 0, 0, 1, 0x67]))).toBe(7);
    expect(firstNalUnitType(Uint8Array.from([0, 0, 1, 0x65]))).toBe(5);
    expect(firstNalUnitType(Uint8Array.from([0, 0, 0, 1, 0x41]))).toBe(1);
  });

  it("rejects data without an Annex-B start code", () => {
    expect(firstNalUnitType(Uint8Array.from([0x67, 1, 2, 3]))).toBeNull();
  });
});
