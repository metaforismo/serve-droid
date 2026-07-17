import { describe, expect, it } from "vitest";
import { canQueueAudio, nextAudioReconnectDelay, scheduledAudioTime } from "../src/audio.js";

describe("audio playback clock", () => {
  it("keeps a healthy contiguous schedule", () => {
    expect(scheduledAudioTime(10, 10.08)).toBe(10.08);
  });

  it("resynchronizes stale and excessively buffered audio", () => {
    expect(scheduledAudioTime(10, 9)).toBeCloseTo(10.03);
    expect(scheduledAudioTime(10, 10.75)).toBeCloseTo(10.03);
  });

  it("bounds decoder backpressure and rejects invalid queue sizes", () => {
    expect(canQueueAudio(0)).toBe(true);
    expect(canQueueAudio(11)).toBe(true);
    expect(canQueueAudio(12)).toBe(false);
    expect(canQueueAudio(-1)).toBe(false);
    expect(canQueueAudio(Number.NaN)).toBe(false);
  });

  it("uses bounded reconnect backoff", () => {
    expect(nextAudioReconnectDelay(250)).toBe(500);
    expect(nextAudioReconnectDelay(4_000)).toBe(5_000);
    expect(nextAudioReconnectDelay(5_000)).toBe(5_000);
  });
});
