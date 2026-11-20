import assert from "node:assert/strict";
import { runBurst } from "../functions/recording-transcribe/burst.ts";

Deno.test("a burst stops on a processing error and claims a new lease after each accepted cursor", async () => {
  const events: string[] = [];
  await runBurst({ state: "processing", cursor: 0 }, {
    process: job => {
      events.push("process " + job.cursor);
      return Promise.resolve(job.cursor === 1 ? null : { state: "processing", cursor: job.cursor + 1 });
    },
    claim: job => {
      events.push("claim " + job.cursor);
      return Promise.resolve(job);
    },
    release: () => Promise.resolve(),
    maxSteps: 6,
  });
  assert.deepEqual(events, ["process 0", "claim 1", "process 1"]);
});

Deno.test("a lost CAS ends the burst without processing another worker's cursor", async () => {
  let calls = 0;
  await runBurst({ state: "processing" }, {
    process: job => { calls++; return Promise.resolve(job); },
    claim: () => Promise.resolve(null),
    release: () => Promise.resolve(),
    maxSteps: 6,
  });
  assert.equal(calls, 1);
});

Deno.test("a burst releases an acquired lease when the time budget is exhausted", async () => {
  let time = 0;
  let released = false;
  await runBurst({ state: "processing" }, {
    process: job => { time += 90_000; return Promise.resolve(job); },
    claim: job => Promise.resolve(job),
    release: () => { released = true; return Promise.resolve(); },
    maxSteps: 6,
    now: () => time,
  });
  assert.ok(released);
});
