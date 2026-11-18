import type { SupabaseClient } from "npm:@supabase/supabase-js@2.58.0";
import { GeminiError } from "./gemini.ts";
import { maxTranscriptCharacters, formatMeetingSummary } from "./summary-format.ts";
import type { MeetingSummary } from "./summary-format.ts";
import { extractSummaryBlock, generateMeetingSummary, splitSummaryInput } from "./summary-model.ts";
import type { SummaryExtract, SummaryInput } from "./summary-model.ts";
import { backgroundRetry } from "./background-retry.ts";
import { deliveryStatus } from "./telegram-delivery.ts";
import { summaryValidity } from "./question-core.ts";
import type { Revision } from "./question-core.ts";

type Job = {
  id: string;
  access_hash: string;
  state: "processing" | "completed" | "failed";
  input: SummaryInput | null;
  extracts: SummaryExtract[];
  step: number;
  total_steps: number;
  lease: string | null;
  result: MeetingSummary | null;
  question_revisions?: Revision[];
  question_version?: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  retry_count: number;
  retry_at: string | null;
  telegram_binding_id: string | null;
};

type Reply = { body: object; status: number };

function failure(code: string, status: number): Reply {
  return { body: { code }, status };
}

async function response(db: SupabaseClient, job: Job): Promise<Reply> {
  const delivery = await deliveryStatus(db, "summary", job);
  if (job.state === "completed" && job.result) {
    const current = job.question_revisions?.at(-1)?.result ?? job.result;
    return { status: 200, body: {
      status: job.state, delivery, text: formatMeetingSummary(current), notes: current.notes,
      questionVersion: job.question_version ?? 0, questionExpiresAt: Date.parse(job.created_at) + summaryValidity,
    } };
  }
  if (job.state === "failed") return { status: 200, body: { status: job.state, delivery, code: job.error_code } };
  return { status: 202, body: { status: job.state, delivery, stepsDone: job.step, totalSteps: job.total_steps } };
}

function trim(value: unknown, length: number) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, length) : "";
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

async function fingerprint(input: SummaryInput) {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (part) => part.toString(16).padStart(2, "0")).join("");
}

async function runStep(db: SupabaseClient, job: Job, key: string) {
  const persist = async (changes: Record<string, unknown>) => {
    const { error } = await db.from("meeting_summaries").update({
      ...changes, lease: null, updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("lease", job.lease);
    if (error) throw error;
  };

  try {
    if (!job.input) throw new GeminiError("summary_interrupted", 409);
    if (job.step + 1 === job.total_steps) {
      const result = await generateMeetingSummary(key, job.input, job.extracts);
      await persist({ state: "completed", result, step: job.total_steps, extracts: [], retry_count: 0, retry_at: null });
    } else {
      const extract = await extractSummaryBlock(key, job.input, job.step);
      await persist({ step: job.step + 1, extracts: [...job.extracts, extract], retry_count: 0, retry_at: null });
    }
  } catch (error) {
    const code = error instanceof GeminiError ? error.code : "summary_interrupted";
    console.error("meeting_summary_step_failed", code);
    try {
      const retry = backgroundRetry(job.retry_count, ["polza_unavailable", "polza_busy", "summary_incomplete", "summary_interrupted"].includes(code));
      await persist(retry ?? { state: "failed", input: null, extracts: [], error_code: code });
    } catch {
      console.error("meeting_summary_checkpoint_failed");
    }
  }
}

export async function handleMeetingSummary(
  db: SupabaseClient,
  body: Record<string, unknown>,
  accessHash: string,
  browserHash: string | null,
  getClientHash: () => Promise<string>,
  key: string | undefined,
  waitUntil: (task: Promise<unknown>) => void,
): Promise<Reply> {
  const { id, action } = body;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
    (action !== "create" && action !== "status")) return failure("invalid_request", 400);

  if (action === "create") {
    if (!key) return failure("polza_unconfigured", 503);
    const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
    if (!transcript || !/[\p{L}\p{N}]/u.test(transcript)) return failure("summary_empty", 400);
    if (transcript.length > maxTranscriptCharacters) return failure("summary_too_long", 413);
    const date = trim(body.date, 20);
    if (date && !validDate(date)) return failure("summary_date", 400);
    const input: SummaryInput = {
      blocks: splitSummaryInput(transcript), date,
      sourceName: trim(body.sourceName, 180), title: trim(body.title, 160),
      participants: (typeof body.participants === "string" ? body.participants.split(/[,;\n]+/) : [])
        .slice(0, 40).map((part) => trim(part, 80)).filter(Boolean),
      facilitated: body.facilitated === true,
    };
    const { data, error } = await db.rpc("reserve_summary_background", {
      p_id: id, p_access_hash: accessHash, p_client_hash: await getClientHash(), p_input_hash: await fingerprint(input),
      p_input: input, p_total_steps: input.blocks.length > 1 ? input.blocks.length + 1 : 1,
      p_browser_hash: browserHash,
    });
    if (error) throw error;
    if (data === "forbidden") return failure("forbidden", 403);
    if (data === "service_busy") return failure("service_busy", 429);
    if (data === "summary_conflict") return failure("summary_conflict", 409);
    if (data !== "ready") throw new Error("summary_reservation_failed");
  }

  const { data, error } = await db.from("meeting_summaries").select("*")
    .eq("id", id).eq("access_hash", accessHash).maybeSingle();
  if (error) throw error;
  const job = data as Job | null;
  if (!job || Date.now() - Date.parse(job.created_at) >= summaryValidity) return failure("summary_missing", 404);
  if (action === "create" && key) await advanceSummary(db, job, key, waitUntil);
  return await response(db, job);
}

export async function advanceSummary(
  db: SupabaseClient, job: Job, key: string, schedule: (task: Promise<unknown>) => void,
) {
  if (job.state !== "processing") return;
  const now = Date.now();
  if (job.retry_at && Date.parse(job.retry_at) > now) return;
  if (job.lease) {
    if (now - Date.parse(job.updated_at) < 160_000) return;
    const retry = backgroundRetry(job.retry_count, true, now);
    const { error } = await db.from("meeting_summaries").update({
      ...(retry ?? { state: "failed", input: null, extracts: [], error_code: "summary_interrupted" }),
      lease: null, updated_at: new Date(now).toISOString(),
    }).eq("id", job.id).eq("state", "processing").eq("lease", job.lease);
    if (error) throw error;
    return;
  }
  const { data: leased, error } = await db.from("meeting_summaries")
    .update({ lease: crypto.randomUUID(), updated_at: new Date(now).toISOString() })
    .eq("id", job.id).eq("state", "processing").eq("step", job.step).eq("updated_at", job.updated_at)
    .is("lease", null).select("*").maybeSingle();
  if (error) throw error;
  if (leased) schedule(runStep(db, leased as Job, key));
}

export async function tickSummaries(db: SupabaseClient, key: string, schedule: (task: Promise<unknown>) => void) {
  const now = Date.now();
  const { data, error } = await db.from("meeting_summaries").select("*").eq("state", "processing")
    .gt("created_at", new Date(now - summaryValidity).toISOString())
    .or("retry_at.is.null,retry_at.lte." + new Date(now).toISOString())
    .or("lease.is.null,updated_at.lte." + new Date(now - 160_000).toISOString())
    .order("updated_at").limit(2);
  if (error) throw error;
  for (const job of data as Job[]) await advanceSummary(db, job, key, schedule);
}
