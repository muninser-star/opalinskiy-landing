import assert from "node:assert/strict";
import { AudioSourceError, openRawAudio } from "../functions/recording-transcribe/raw-media.ts";

Deno.test("a temporary range fetch failure remains retryable instead of becoming damaged audio", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = () => Promise.reject(new TypeError("network failure"));
    await assert.rejects(openRawAudio("https://example.invalid/test.m4a"),
      (error: unknown) => error instanceof AudioSourceError && error.status === 502 && error.code === "source_unavailable");
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 503 }));
    await assert.rejects(openRawAudio("https://example.invalid/test.m4a"),
      (error: unknown) => error instanceof AudioSourceError && error.status === 503);
    await assert.rejects(openRawAudio(new TextEncoder().encode("broken audio")),
      (error: unknown) => error instanceof AudioSourceError && error.status === 422 && error.code === "decode_audio");
  } finally {
    globalThis.fetch = original;
  }
});
