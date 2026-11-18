import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.58.0";
import { formatMeetingSummary } from "../functions/recording-transcribe/summary-format.ts";
import { handleQuestion } from "../functions/recording-transcribe/questions.ts";

const id = "11111111-1111-4111-8111-111111111111";
const key = "synthetic-access-hash";
const secret = "synthetic-signing-key";

function fixture() {
  const record = {
    id, access_hash: key, state: "completed", created_at: new Date().toISOString(),
    input: { blocks: ["**00:10:12 · Спикер 1**\n\nОтчёт соберём до пятницы.\n\nАнна озвучила итог."], participants: [] },
    result: {
      title: "Подготовка отчёта", date: null, participants: ["Анна"],
      decisions: [], thoughts: [], questions: [], notes: [],
      actions: [{ owner: "Анна", task: "Собрать отчёт", due: "в четверг" }],
    },
    question_version: 0, question_revisions: [],
  };
  let modelCalls = 0;
  let rateCalls = 0;
  type Row = Record<string, unknown>;
  class Query {
    #tests: ((row: Row) => boolean)[] = [];
    #changes: Row = {};
    constructor(private rows: Row[]) {}
    select() { return this; }
    eq(field: string, value: string | number) {
      this.#tests.push((row) => row[field] === value);
      return this;
    }
    gt(field: string, value: string) {
      this.#tests.push((row) => String(row[field]) > value);
      return this;
    }
    update(changes: Row) {
      this.#changes = changes;
      return this;
    }
    maybeSingle() {
      const row = this.rows.find((item) => this.#tests.every((test) => test(item)));
      if (row) Object.assign(row, this.#changes);
      return Promise.resolve({ data: row ? structuredClone(row) : null, error: null });
    }
  }

  const client = {
    from(table: string) {
      return new Query(table === "meeting_summaries" ? [record] : [{
        id, access_hash: key, state: "completed",
        segments: [{ text: "Анна подтвердила дату отправки.", start: 67.9, speaker: "a" }],
      }]);
    },
    rpc() {
      rateCalls++;
      return Promise.resolve({ data: true, error: null });
    },
  } as unknown as SupabaseClient;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    modelCalls++;
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.contents[0].parts[1].text);
    const isRecording = input.summary === null;
    if (isRecording) assert.equal(input.source[0].speaker, "Анна");
    const output = isRecording
      ? { answer: "Дату отправки подтвердила Анна.", citations: [{ id: 1, quote: "Анна подтвердила дату отправки." }], edit: null }
      : { answer: "Отчёт соберут до пятницы.", citations: [
        { id: 1, quote: "Отчёт соберём до пятницы.", timecode: "99:59:58" },
        { id: 1, quote: "Несуществующая цитата" },
        { id: 99, quote: "Отчёт соберём до пятницы." },
      ], edit: { field: "actions.0.due", value: "до пятницы" } };
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(output) }] } }] });
  };
  return {
    record,
    modelCalls: () => modelCalls,
    rateCalls: () => rateCalls,
    request: (body: Row, access = key) =>
      handleQuestion(client, { id, kind: "summary", ...body }, access, () => Promise.resolve("ip-hash"), "fixture", secret),
    finish: () => { globalThis.fetch = originalFetch; },
  };
}

Deno.test("wrong access cannot read citations, invoke the model or apply an edit", async () => {
  const test = fixture();
  try {
    assert.equal((await test.request({ action: "ask", question: "Какой срок?" }, "wrong")).status, 404);
    assert.equal((await test.request({ action: "apply", token: "existing.token" }, "wrong")).status, 404);
    assert.equal((await test.request({ action: "ask", kind: "recording", question: "Кто?" }, "wrong")).status, 404);
    assert.equal(test.rateCalls(), 0);
    assert.equal(test.modelCalls(), 0);
  } finally {
    test.finish();
  }
});

Deno.test("verified evidence has original timing and an explicit versioned edit preserves the Telegram original", async () => {
  const test = fixture();
  try {
    const first = await test.request({ action: "ask", question: "Срок неверный. Какой срок прозвучал?" });
    const next = await test.request({ action: "ask", question: "Уточни срок ещё раз." });
    assert.equal(first.status, 200);
    const body = first.body as { citations: object[]; proposal: { token: string; before: string; after: string } };
    const stale = (next.body as { proposal: { token: string } }).proposal;
    assert.deepEqual(body.citations, [{ quote: "Отчёт соберём до пятницы.", timecode: "00:10:12", speaker: undefined }]);
    assert.equal(body.proposal.before, "в четверг");
    assert.equal(body.proposal.after, "до пятницы");
    assert.equal(test.record.question_version, 0);

    const applied = await test.request({ action: "apply", token: body.proposal.token });
    assert.equal(applied.status, 200);
    assert.equal((applied.body as { questionVersion: number }).questionVersion, 1);
    assert.match((applied.body as { text: string }).text, /до пятницы/u);
    assert.match(formatMeetingSummary(test.record.result), /в четверг/u);
    assert.equal((await test.request({ action: "apply", token: stale.token })).status, 409);
    assert.equal((await test.request({ action: "apply", token: body.proposal.token })).status, 200);
    assert.equal(test.record.question_version, 1);
  } finally {
    test.finish();
  }
});

Deno.test("recording answers cite segmentation timing and selected speaker names", async () => {
  const test = fixture();
  try {
    const result = await test.request({ kind: "recording", action: "ask", question: "Кто подтвердил дату?", names: { a: "Анна" } });
    assert.equal(result.status, 200);
    assert.deepEqual((result.body as { citations: object[] }).citations,
      [{ quote: "Анна подтвердила дату отправки.", timecode: "00:01:07", speaker: "Анна" }]);
    assert.equal((result.body as { proposal: object | null }).proposal, null);
  } finally {
    test.finish();
  }
});

Deno.test("an expired summary is rejected and a legacy summary explains absent source", async () => {
  const test = fixture();
  try {
    const recent = structuredClone(test.record);
    Object.assign(test.record, { created_at: new Date(Date.now() - 25 * 3600_000).toISOString() });
    assert.equal((await test.request({ action: "ask", question: "Срок?" })).status, 404);
    Object.assign(test.record, recent, { input: null });
    assert.deepEqual(await test.request({ action: "ask", question: "Срок?" }),
      { status: 409, body: { code: "question_source_missing" } });
    assert.equal(test.modelCalls(), 0);
  } finally {
    test.finish();
  }
});
