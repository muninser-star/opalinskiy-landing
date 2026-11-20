import assert from "node:assert/strict";
import { nextPiece, pieceWindow } from "../functions/recording-transcribe/piece-plan.ts";
import { GeminiError, recognizeAudioWindow } from "../functions/recording-transcribe/gemini.ts";

Deno.test("smaller windows resume a legacy piece without replaying its accepted prefix", () => {
  const job = { parts_done: 3, part_piece: 1, piece_offset_seconds: 0, piece_seconds: 15, duration_seconds: 2700 };
  assert.deepEqual(pieceWindow(job), { boundary: 1200, start: 1188, end: 1215 });
  const first = nextPiece(job, 1215);
  assert.deepEqual(first, { parts_done: 3, part_piece: 1, piece_offset_seconds: 15, piece_seconds: 15 });
  assert.deepEqual(pieceWindow({ ...job, ...first }), { boundary: 1215, start: 1203, end: 1230 });
  assert.deepEqual(nextPiece(job, 1320), { parts_done: 3, part_piece: 2, piece_offset_seconds: 0, piece_seconds: 120 });
  assert.deepEqual(nextPiece({ ...job, part_piece: 2 }, 1440),
    { parts_done: 4, part_piece: 0, piece_offset_seconds: 0, piece_seconds: 120 });
});

Deno.test("MAX_TOKENS never saves partial model text and small windows retain the same model", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, request) => {
      assert.match(String(url), /gemini-2\.5-flash:generateContent$/);
      const body = JSON.parse(String(request?.body));
      assert.equal(body.generationConfig.temperature, 0);
      assert.equal(body.generationConfig.maxOutputTokens, 2048);
      assert.equal(body.contents[0].parts[1].inlineData.mimeType, "audio/aac");
      return Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } }] });
    };
    await assert.rejects(
      recognizeAudioWindow("test", new Uint8Array([1]), { boundary: 30, start: 18, end: 45 }, [], true, 1000, "audio/aac"),
      (error: unknown) => error instanceof GeminiError && error.reason === "MAX_TOKENS",
    );
  } finally {
    globalThis.fetch = original;
  }
});
