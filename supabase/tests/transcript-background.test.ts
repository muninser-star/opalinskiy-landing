import assert from "node:assert/strict";
import { backgroundRetry } from "../functions/recording-transcribe/background-retry.ts";
import { generateMeetingSummary } from "../functions/recording-transcribe/summary-model.ts";
import { confirmedParticipant } from "../functions/recording-transcribe/summary-people.ts";
import { makeTranscript, sendDocument } from "../functions/recording-transcribe/telegram-delivery.ts";

Deno.test("summary grounds names and owners in the current recording", async () => {
  const originalFetch = globalThis.fetch;
  const transcript = "Спикер 1: Меня зовут Сергей. Я подготовлю отчёт.\n" +
    "Спикер 2: Меня зовут Сергей Новиков. Обсудим письмо от Павла Синицына.";
  try {
    globalThis.fetch = async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      const input = JSON.parse(body.contents[0].parts[1].text);
      assert.equal(input.transcript, transcript);
      assert.equal(Object.hasOwn(input, "directory"), false);
      const model = {
        title: "Отчёт · Сергей Тестов", date: null,
        participants: ["Сергей", "Сергей Тестов", "Сергей Новиков", "Павел Синицын"],
        personMentions: ["Сергей Тестов"],
        decisions: [{ text: "Сергей Тестов подготовит отчёт.", highlight: "отчёт" }],
        thoughts: [], questions: [], notes: [],
        actions: [{
          task: "Подготовить отчёт", owner: "Сергей Тестов", ownerEvidence: "Меня зовут Сергей.",
          due: null, highlight: "отчёт", request: false, requestRecipient: null, requestEvidence: null,
        }],
      };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(model) }] } }] });
    };
    const result = await generateMeetingSummary("fixture", {
      blocks: [transcript], title: "", date: "", sourceName: "", participants: [], facilitated: false,
    }, []);
    assert.deepEqual(result.participants, ["Сергей", "Сергей Новиков"]);
    assert.equal(result.actions[0].owner, null);
    assert.equal(result.decisions[0].text, "Сергей подготовит отчёт.");
    assert.ok(!JSON.stringify(result).includes("Тестов"));
    assert.ok(confirmedParticipant("Спикер 1: Меня зовут Сергей Новиков.", "Сергей Новиков"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("delivery sends a downloadable Markdown document and distinguishes unknown sends", async () => {
  const originalFetch = globalThis.fetch;
  const document = makeTranscript("Проверка.m4a", 13, [{ start: 4, end: 7, speaker: "one", text: "Синтетическая реплика" }]);
  try {
    globalThis.fetch = async (url, request) => {
      assert.match(String(url), /\/sendDocument$/);
      const body = request?.body as FormData;
      const file = body.get("document") as File;
      assert.equal(file.name, "Проверка.md");
      assert.equal(body.has("protect_content"), false);
      assert.match(await file.text(), /00:00:04 · Спикер 1/);
      return Response.json({ ok: true, result: { message_id: 19 } });
    };
    assert.deepEqual(await sendDocument("fixture", "123", document, 1), { state: "sent", telegram_message_id: 19 });
    globalThis.fetch = async () =>
      Response.json({ ok: false, error_code: 429, parameters: { retry_after: 15 } }, { status: 429 });
    assert.deepEqual(await sendDocument("fixture", "123", document, 1, 0), {
      state: "pending", next_at: "1970-01-01T00:00:15.000Z",
    });
    globalThis.fetch = () => Promise.reject(new Error("lost response"));
    assert.deepEqual(await sendDocument("fixture", "123", document, 1), { state: "unknown" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("background retries have a limit", () => {
  assert.deepEqual(backgroundRetry(1, true, 0), { retry_count: 2, retry_at: "1970-01-01T00:01:00.000Z" });
  assert.equal(backgroundRetry(3, true, 0), null);
  assert.equal(backgroundRetry(0, false, 0), null);
});
