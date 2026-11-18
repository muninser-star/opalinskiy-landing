import { createClient } from "npm:@supabase/supabase-js@2.58.0";
import { maxPartBytes, maxRecordingSeconds, partCount } from "./audio-plan.ts";
import { GeminiError, recognizePiece } from "./gemini.ts";
import type { Segment } from "./gemini.ts";
import { handleMeetingSummary, tickSummaries } from "./summary-jobs.ts";
import { handleQuestion } from "./questions.ts";
import { backgroundRetry } from "./background-retry.ts";
import { browserHash, deliveryStatus, handleTelegram, safeRecordingName, tickDeliveries } from "./telegram-delivery.ts";

declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };

const bucket = "transcription-uploads";
const maxBytes = 50 * 1024 * 1024;
const audioTypes: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
  webm: "audio/webm",
};
const polzaUrl = "https://polza.ai/api/v1/audio/transcriptions";
const inlineAudioLimit = 4 * 1024 * 1024;
const polzaModel = "aiesa/transcribe";
const audience = "recording-transcribe";
const publicSigningKey = {"key_ops":["verify"],"ext":true,"kty":"EC","x":"Awx4io-cWkDLv3j8WM2mbA8Mfowi0lJjsbUGtMZozHs","y":"0-yE21yHqr-J7egP0xxNm_gZLcit3mQdAnZvcEs2Zd4","crv":"P-256"};
const apexOrigin = "https://www.opalinskiy.ru";
const guestOrigins = new Set([apexOrigin, "https://opalinskiy-landing.pages.dev"]);
const allowedOrigins = new Set([
  ...guestOrigins,
  "https://denis-transcript.auburncoot.chatgpt.site",
  "https://transcript.opalinskiy.ru",
]);
const projectUrl = Deno.env.get("SUPABASE_URL")!;
const projectRef = new URL(projectUrl).hostname.split(".")[0];
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(projectUrl, serviceKey, {
  auth: { persistSession: false },
});
const objects = db.storage.from(bucket);

type Job = {
  id: string;
  audio_path: string;
  audio_bytes: number;
  access_hash: string | null;
  client_hash: string | null;
  audio_removed: boolean;
  state: "uploading" | "submitting" | "processing" | "completed" | "failed";
  provider_id: string | null;
  error_code: string | null;
  updated_at: string;
  created_at: string;
  part_count: number | null;
  duration_seconds: number | null;
  parts_done: number;
  part_piece: number;
  part_lease: string | null;
  segments: Segment[];
  original_name: string | null;
  provider_result_duration: number | null;
  provider_result_saved: boolean;
  retry_count: number;
  retry_at: string | null;
  telegram_binding_id: string | null;
};
type ProviderResult = {
  id?: string;
  status?: string;
  duration?: number;
  text?: string;
  segments?: Array<{
    speaker?: string | number;
    text?: string;
    start?: number;
    end?: number;
    startTime?: string;
    endTime?: string;
  }>;
};
type Action = {
  action?: string;
  id?: string;
  size?: number;
  extension?: string;
  name?: string;
  duration?: number;
  index?: number;
  partBytes?: number;
};

function reply(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function problem(code: string, status: number) {
  return reply({ code }, status);
}

function decodeBase64url(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (byte) => byte.charCodeAt(0));
}

async function validSession(request: Request) {
  const token = request.headers.get("x-transcription-session") ?? "";
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false;
  try {
    const [head, payload, signature] = token.split(".");
    const decoder = new TextDecoder();
    const header = JSON.parse(decoder.decode(decodeBase64url(head)));
    const claims = JSON.parse(decoder.decode(decodeBase64url(payload)));
    const now = Math.floor(Date.now() / 1000);
    if (header?.alg !== "ES256" || header.typ !== "JWT" || claims?.aud !== audience ||
        !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > now + 60 ||
        claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 1800) return false;
    if (claims.challenge !== undefined) {
      const proof = request.headers.get("x-transcription-proof") ?? "";
      const origin = request.headers.get("origin");
      if (!/^[A-Za-z0-9_-]{43}$/.test(proof) || (origin && origin !== apexOrigin)) return false;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof)));
      const expected = btoa(String.fromCharCode(...digest)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
      if (claims.challenge !== expected) return false;
    }
    const key = await crypto.subtle.importKey(
      "jwk", publicSigningKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, decodeBase64url(signature), new TextEncoder().encode(head + "." + payload),
    );
  } catch {
    return false;
  }
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (part) => part.toString(16).padStart(2, "0")).join("");
}

async function guestHash(request: Request) {
  const access = request.headers.get("x-transcription-job") ?? "";
  if (!guestOrigins.has(request.headers.get("origin") ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(access)) return null;
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(access)));
}

async function clientHash(request: Request) {
  const header = request.headers.get("cf-connecting-ip") ?? "";
  const ip = /^[0-9a-f:.]{1,45}$/i.test(header) ? header : "unknown";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(serviceKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode("transcription:" + ip)));
}

async function readAction<T = Action>(request: Request, maxBytes = 2048) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let raw = "";
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return JSON.parse(raw + decoder.decode()) as T | null;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      return null;
    }
    raw += decoder.decode(value, { stream: true });
  }
}

function polzaKey() {
  return Deno.env.get("POLZA_API_KEY") || Deno.env.get("EMBEDDINGS_API_KEY");
}

async function readJob(id: string) {
  const { data, error } = await db.from("transcription_jobs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as Job | null;
}

async function updateJob(id: string, patch: Partial<Job>, previous?: Job["state"]) {
  let query = db.from("transcription_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (previous) query = query.eq("state", previous);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw error;
  return data as Job | null;
}

type StoredAudio = Pick<Job, "id" | "audio_path" | "audio_removed" | "part_count">;

function partName(index: number) {
  return "part-" + index + ".mp3";
}

function partFolder(id: string) {
  return "recordings/" + id;
}

function audioPaths(job: StoredAudio) {
  if (job.part_count === null) return [job.audio_path];
  return Array.from({ length: job.part_count }, (_, index) => partFolder(job.id) + "/" + partName(index));
}

async function removeAudio(job: StoredAudio) {
  if (job.audio_removed) return;
  const { error } = await objects.remove(audioPaths(job));
  if (!error) {
    const { error: updateError } = await db.from("transcription_jobs")
      .update({ audio_removed: true }).eq("id", job.id);
    if (updateError) console.warn("transcription_cleanup_update_failed");
  } else {
    console.warn("transcription_cleanup_failed");
  }
}

async function cleanupExpiredUploads() {
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from("transcription_jobs")
    .select("id,audio_path,audio_removed,part_count,state").eq("audio_removed", false).lt("created_at", cutoff).limit(10);
  if (error || !data?.length) return;
  const { error: removalError } = await objects.remove(data.flatMap(audioPaths));
  if (removalError) return;
  const ids = data.map((row) => row.id);
  await db.from("transcription_jobs").update({ audio_removed: true }).in("id", ids);
  await db.from("transcription_jobs")
    .update({ state: "failed", error_code: "upload_expired", updated_at: new Date().toISOString() })
    .in("id", ids).eq("state", "uploading");
}

async function snapshot(job: Job) {
  return reply({
    status: job.state,
    delivery: await deliveryStatus(db, "transcript", job),
    ...(job.state === "completed" ? {
      segments: job.segments, duration: job.duration_seconds ?? job.provider_result_duration,
    } : {}),
    code: job.error_code ?? undefined,
    partsDone: job.part_count === null ? undefined : job.parts_done,
    partCount: job.part_count ?? undefined,
    resumable: canResume(job) || undefined,
  });
}

async function prepare(id: string, body: Action, request: Request, accessHash: string | null) {
  const size = body.size;
  const extension = body.extension ?? "";
  if (typeof extension !== "string" || !Object.hasOwn(audioTypes, extension)) return problem("format", 400);
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    return problem("file_size", 413);
  }
  const duration = body.duration;
  if (duration !== undefined && (!accessHash || typeof duration !== "number" || !Number.isFinite(duration) ||
      duration <= 0 || duration > maxRecordingSeconds)) {
    return problem("duration", 422);
  }
  if (!polzaKey()) return problem("polza_unconfigured", 503);

  const path = "recordings/" + id + "." + extension;
  if (accessHash) {
    const { data, error } = await db.rpc("reserve_transcription_guest_upload", {
      p_id: id, p_audio_path: path, p_audio_bytes: size,
      p_access_hash: accessHash, p_client_hash: await clientHash(request),
    });
    if (error) throw error;
    if (data === "busy") return problem("service_busy", 429);
    if (data === "file_conflict") return problem("file_conflict", 409);
    if (data !== "ready") return problem("forbidden", 403);
  } else {
    const { error } = await db.from("transcription_jobs").upsert(
      { id, audio_path: path, audio_bytes: size }, { onConflict: "id", ignoreDuplicates: true },
    );
    if (error) throw error;
  }

  let job = await readJob(id);
  if (!job || job.access_hash !== accessHash) return problem("forbidden", 403);
  if (job.audio_path !== path || job.audio_bytes !== size) return problem("file_conflict", 409);
  if (job.state !== "uploading") return snapshot(job);

  const originalName = safeRecordingName(body.name);
  if (originalName && !job.original_name) {
    const { error } = await db.from("transcription_jobs").update({ original_name: originalName })
      .eq("id", id).eq("state", "uploading").is("original_name", null);
    if (error) throw error;
  }
  await cleanupExpiredUploads();
  if (job.audio_removed || Date.now() - Date.parse(job.created_at) > 72 * 3600_000) return problem("upload_expired", 410);
  if (duration !== undefined) {
    if (job.part_count === null) {
      const { data, error } = await db.from("transcription_jobs")
        .update({ part_count: partCount(duration), duration_seconds: duration })
        .eq("id", id).eq("state", "uploading").is("part_count", null).select("*").maybeSingle();
      if (error) throw error;
      job = data as Job | null ?? await readJob(id);
      if (!job) return problem("job_missing", 404);
    }
    if (Math.abs((job.duration_seconds ?? 0) - duration) > 0.01) return problem("file_conflict", 409);
    return snapshot(job);
  }
  if (job.part_count !== null) return snapshot(job);
  const { data: info } = await objects.info(path);
  if (Number(info?.size) === job.audio_bytes) return reply({ status: "uploaded" });
  return signedUpload(path, audioTypes[extension]);
}

async function signedUpload(path: string, contentType: string) {
  const { data, error: signingError } = await objects.createSignedUploadUrl(path);
  if (signingError || !data?.token) return problem("storage_signing", 502);
  return reply({
    status: "uploading",
    endpoint: "https://" + projectRef + ".storage.supabase.co/storage/v1/upload/resumable/sign",
    token: data.token,
    bucket,
    path,
    contentType,
  });
}

async function preparePart(job: Job, action: Action) {
  const { index, partBytes } = action;
  if (job.part_count === null || typeof index !== "number" || !Number.isSafeInteger(index) ||
      index < 0 || index >= job.part_count || typeof partBytes !== "number" ||
      !Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > maxPartBytes) {
    return problem("invalid_request", 400);
  }
  if (job.state !== "uploading") return snapshot(job);
  if (job.audio_removed || Date.now() - Date.parse(job.created_at) > 72 * 3600_000) return problem("upload_expired", 410);
  const path = partFolder(job.id) + "/" + partName(index);
  const { data: info } = await objects.info(path);
  if (info && Number(info.size) === partBytes) return reply({ status: "uploaded" });
  if (info) return problem("file_conflict", 409);
  const { data, error } = await objects.createSignedUploadUrl(path);
  if (error || !data?.signedUrl) return problem("storage_signing", 502);
  return reply({ status: "uploading", uploadUrl: data.signedUrl });
}

function providerProblem(status: number) {
  if (status === 401 || status === 403) return problem("polza_key_rejected", 503);
  if (status === 402) return problem("polza_balance", 402);
  if (status === 429) return problem("polza_busy", 429);
  return problem("polza_rejected", 422);
}

async function audioSource(job: Job) {
  if (job.audio_bytes <= inlineAudioLimit) {
    const { data, error } = await objects.download(job.audio_path);
    if (error || !data || data.size !== job.audio_bytes) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    const extension = job.audio_path.split(".").at(-1) ?? "";
    return "data:" + audioTypes[extension] + ";base64," + btoa(binary);
  }
  const { data, error } = await objects.createSignedUrl(job.audio_path, 6 * 3600);
  return error ? null : data?.signedUrl ?? null;
}

async function submit(job: Job, hash: string | null) {
  if (job.state !== "uploading") return snapshot(job);
  const key = polzaKey();
  if (!key) return problem("polza_unconfigured", 503);

  if (job.audio_removed) return problem("upload_expired", 410);
  let file: string | null = null;
  if (job.part_count !== null) {
    const { data, error } = await objects.list(partFolder(job.id), { limit: job.part_count + 1 });
    if (error) return problem("storage_signing", 502);
    const present = new Set(data.filter((item) => {
      const size = Number(item.metadata?.size);
      return size > 0 && size <= maxPartBytes;
    }).map((item) => item.name));
    if (present.size !== job.part_count ||
        Array.from({ length: job.part_count }, (_, index) => partName(index)).some((name) => !present.has(name))) {
      return problem("upload_incomplete", 409);
    }
  } else {
    const { data: info, error: infoError } = await objects.info(job.audio_path);
    if (infoError || Number(info?.size) !== job.audio_bytes) return problem("upload_incomplete", 409);
    file = await audioSource(job);
    if (!file) return problem("storage_signing", 502);
  }

  let locked: boolean;
  if (job.access_hash) {
    const { data, error } = await db.rpc("reserve_transcript_background", {
      p_id: job.id, p_access_hash: job.access_hash, p_browser_hash: hash,
    });
    if (error) throw error;
    if (data === "busy") return problem("service_busy", 429);
    if (data === "forbidden") return problem("forbidden", 403);
    locked = data === "ready";
  } else {
    locked = !!await updateJob(job.id, { state: "submitting" }, "uploading");
  }
  if (!locked) {
    const current = await readJob(job.id);
    return current ? snapshot(current) : problem("job_missing", 404);
  }

  if (job.part_count !== null) {
    const started = await updateJob(job.id, { state: "processing", error_code: null }, "submitting");
    return started ? await advancePart(started, (task) => EdgeRuntime.waitUntil(task)) : problem("server_error", 500);
  }

  let response: Response;
  try {
    response = await fetch(polzaUrl, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: polzaModel, language: "ru", file }),
      signal: AbortSignal.timeout(75_000),
      redirect: "error",
    });
  } catch (error) {
    console.warn("transcription_submit_connection", error instanceof Error ? error.name : "unknown");
    await updateJob(job.id, { state: "failed", error_code: "submission_unknown" }, "submitting");
    return problem("submission_unknown", 502);
  }

  if (!response.ok && response.status < 500) {
    const rejected = await response.json().catch(() => null);
    const code = rejected?.error?.code;
    console.warn("transcription_submit_rejected", response.status,
      typeof code === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(code) ? code : "unknown");
    await updateJob(job.id, { state: "uploading" }, "submitting");
    return providerProblem(response.status);
  }

  const result = await response.json().catch(() => null) as ProviderResult | null;
  if (!response.ok || typeof result?.id !== "string" || !/^gen_[A-Za-z0-9_-]{1,100}$/.test(result.id)) {
    console.warn("transcription_submit_unconfirmed", response.status, result ? Object.keys(result) : []);
    await updateJob(job.id, { state: "failed", error_code: "submission_unknown" }, "submitting");
    return problem("submission_unknown", 502);
  }

  const saved = await updateJob(job.id, { state: "processing", provider_id: result.id }, "submitting");
  if (!saved) return problem("submission_unknown", 502);
  return snapshot(saved);
}

function canResume(job: Job) {
  return job.part_count !== null && job.state === "failed" && !job.audio_removed &&
    ["chunk_interrupted", "chunk_incomplete", "polza_key_rejected", "polza_balance", "polza_busy"].includes(job.error_code ?? "");
}

async function savePart(job: Job, patch: Partial<Job>) {
  const { data, error } = await db.from("transcription_jobs")
    .update({ ...patch, updated_at: new Date().toISOString(), part_lease: null })
    .eq("id", job.id).eq("state", "processing").eq("part_lease", job.part_lease!)
    .select("*").maybeSingle();
  if (error) throw error;
  return data as Job | null;
}

async function processPart(job: Job, key: string) {
  const reduced = job.error_code === "reduce_piece";
  try {
    const path = partFolder(job.id) + "/" + partName(job.parts_done);
    const { data, error } = await objects.download(path);
    if (error || !data || data.size < 1 || data.size > maxPartBytes) {
      await savePart(job, { state: "failed", error_code: "upload_expired" });
      return;
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    const piece = await recognizePiece(key, bytes, job.parts_done, job.duration_seconds!, job.part_piece, job.segments, reduced);
    const partsDone = job.parts_done + (piece.last ? 1 : 0);
    const finished = partsDone === job.part_count;
    const saved = await savePart(job, {
      state: finished ? "completed" : "processing",
      parts_done: partsDone,
      part_piece: piece.last ? 0 : job.part_piece + 1,
      segments: [...job.segments, ...piece.segments],
      error_code: null, retry_at: null, retry_count: 0,
    });
    if (finished && saved) await removeAudio(saved);
  } catch (error) {
    const code = error instanceof GeminiError ? error.code : "chunk_interrupted";
    const status = error instanceof GeminiError ? error.status : 0;
    const reason = error instanceof GeminiError ? error.reason ?? "" : "";
    console.warn("transcription_part_failed", code, status, job.parts_done, job.part_piece, reason);
    const retrySmaller = reason === "MAX_TOKENS" && !reduced;
    const retry = backgroundRetry(job.retry_count, status >= 500 || status === 429);
    await savePart(job, retrySmaller
      ? { state: "processing", error_code: "reduce_piece", retry_at: null }
      : retry ?? { state: "failed", error_code: code }).catch(() => {
      console.warn("transcription_part_state_failed");
    });
  }
}

async function advancePart(job: Job, schedule: (task: Promise<unknown>) => void) {
  if (job.retry_at && Date.parse(job.retry_at) > Date.now()) return snapshot(job);
  if (job.state === "submitting") {
    const started = await updateJob(job.id, { state: "processing", error_code: null }, "submitting");
    if (!started) return snapshot(await readJob(job.id) ?? job);
    job = started;
  }
  if (job.state !== "processing") return snapshot(job);
  if (job.part_lease) {
    if (Date.now() - Date.parse(job.updated_at) < 155_000) return snapshot(job);
    const retry = backgroundRetry(job.retry_count, true);
    const recovered = await savePart(job, retry ?? { state: "failed", error_code: "chunk_interrupted" });
    return snapshot(recovered ?? await readJob(job.id) ?? job);
  }
  const key = polzaKey();
  if (!key) return problem("polza_unconfigured", 503);
  const { data, error } = await db.from("transcription_jobs")
    .update({ part_lease: crypto.randomUUID(), updated_at: new Date().toISOString() })
    .eq("id", job.id).eq("state", "processing").eq("parts_done", job.parts_done)
    .eq("part_piece", job.part_piece).eq("updated_at", job.updated_at).is("part_lease", null)
    .select("*").maybeSingle();
  if (error) throw error;
  const leased = data as Job | null;
  if (leased) schedule(processPart(leased, key));
  return snapshot(leased ?? job);
}

async function resume(job: Job) {
  if (!canResume(job)) return snapshot(job);
  const errorCode = ["chunk_incomplete", "chunk_interrupted"].includes(job.error_code ?? "") ? "reduce_piece" : null;
  const { data, error } = await db.from("transcription_jobs")
    .update({ state: "processing", part_lease: null, error_code: errorCode, retry_count: 0, retry_at: null, updated_at: new Date().toISOString() })
    .eq("id", job.id).eq("state", "failed").eq("error_code", job.error_code!)
    .eq("audio_removed", false).select("*").maybeSingle();
  if (error) throw error;
  const restarted = data as Job | null;
  return restarted ? await advancePart(restarted, (task) => EdgeRuntime.waitUntil(task)) : snapshot(await readJob(job.id) ?? job);
}

async function sourceRecording(job: Job) {
  if (job.part_count !== null || job.audio_removed || job.state !== "failed" || job.error_code !== "submission_unknown" ||
      Date.now() - Date.parse(job.created_at) > 72 * 3600_000) {
    return problem("source_unavailable", 410);
  }
  const { data: info } = await objects.info(job.audio_path);
  if (Number(info?.size) !== job.audio_bytes) return problem("source_unavailable", 410);
  const { data, error } = await objects.createSignedUrl(job.audio_path, 600);
  if (error || !data?.signedUrl) return problem("storage_signing", 502);
  return reply({ url: data.signedUrl });
}

function seconds(value: number | undefined, clock: string | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (!clock || !/^\d{1,3}:\d{2}:\d{2}(?:\.\d+)?$/.test(clock)) return 0;
  const [hours, minutes, rest] = clock.split(":").map(Number);
  return hours * 3600 + minutes * 60 + rest;
}

async function getStatus(job: Job): Promise<Response> {
  // Historical provider jobs used a live provider lookup without persisting the result.
  if (job.state === "completed" && job.part_count === null && !job.provider_result_saved) {
    const key = polzaKey();
    if (key) return await advanceProvider(job, key);
  }
  return snapshot(job);
}

async function advanceProvider(job: Job, key: string): Promise<Response> {
  if (job.retry_at && Date.parse(job.retry_at) > Date.now()) return snapshot(job);
  const response = await fetch(polzaUrl + "/" + encodeURIComponent(job.provider_id!), {
    headers: { Authorization: "Bearer " + key },
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  }).catch(() => null);
  if (!response?.ok) {
    if (job.state === "completed") return response?.status === 404
      ? problem("result_expired", 404) : problem("polza_unavailable", 502);
    const status = response?.status ?? 502;
    const code = status === 429 ? "polza_busy" : status === 402 ? "polza_balance"
      : status === 401 || status === 403 ? "polza_key_rejected" : "polza_unavailable";
    const retry = backgroundRetry(job.retry_count, status >= 500 || status === 429 || status === 404);
    const saved = await updateJob(job.id, retry ?? { state: "failed", error_code: code }, "processing");
    return snapshot(saved ?? job);
  }
  const result = await response.json().catch(() => null) as ProviderResult | null;
  if (!result) {
    if (job.state === "completed") return problem("polza_unavailable", 502);
    const retry = backgroundRetry(job.retry_count, true);
    const saved = await updateJob(job.id, retry ?? { state: "failed", error_code: "polza_unavailable" }, "processing");
    return snapshot(saved ?? job);
  }
  if (result.status === "failed") {
    const failed = await updateJob(job.id, { state: "failed", error_code: "recognition_failed" }, "processing");
    if (failed) await removeAudio(failed);
    return snapshot(failed ?? job);
  }
  if (result.status !== "completed") {
    if (job.retry_count) await updateJob(job.id, { retry_count: 0, retry_at: null }, "processing");
    return snapshot(job);
  }
  const segments = (Array.isArray(result.segments) ? result.segments : [])
    .filter((segment) => typeof segment?.text === "string" && segment.text.trim())
    .map((segment) => {
      const start = seconds(segment.start, segment.startTime);
      return {
        speaker: String(segment.speaker ?? "").trim() || null,
        start,
        end: Math.max(start, seconds(segment.end, segment.endTime)),
        text: segment.text!.trim(),
      };
    }).sort((a, b) => a.start - b.start);

  if (!segments.length && result.text?.trim()) {
    if (job.state !== "completed") {
      await updateJob(job.id, { state: "failed", error_code: "missing_segments" }, "processing");
    }
    await removeAudio(job);
    return problem("missing_segments", 422);
  }
  const saved = await updateJob(job.id, {
    state: "completed", segments, provider_result_saved: true,
    provider_result_duration: typeof result.duration === "number" && Number.isFinite(result.duration) ? result.duration : null,
    retry_count: 0, retry_at: null, error_code: null,
  }, job.state);
  if (saved) await removeAudio(saved);
  return snapshot(saved ?? await readJob(job.id) ?? job);
}

async function tickTranscriptions(key: string, schedule: (task: Promise<unknown>) => void) {
  const now = Date.now();
  const { data, error } = await db.from("transcription_jobs").select("*")
    .in("state", ["submitting", "processing"])
    .or("retry_at.is.null,retry_at.lte." + new Date(now).toISOString())
    .or("part_lease.is.null,updated_at.lte." + new Date(now - 155_000).toISOString())
    .order("updated_at").limit(3);
  if (error) throw error;
  for (const job of data as Job[]) {
    if (job.part_count !== null) await advancePart(job, schedule);
    else if (job.state === "submitting") {
      if (now - Date.parse(job.updated_at) >= 120_000) {
        await updateJob(job.id, { state: "failed", error_code: "submission_unknown" }, "submitting");
      }
    } else {
      if (now - Date.parse(job.created_at) >= 72 * 3600_000) {
        await updateJob(job.id, { state: "failed", error_code: "recognition_failed" }, "processing");
        continue;
      }
      // Use the retry timestamp as a short, CAS-protected polling lease. Provider status is a GET.
      const { data: claimed, error } = await db.from("transcription_jobs")
        .update({ retry_at: new Date(now + 30_000).toISOString(), updated_at: new Date(now).toISOString() })
        .eq("id", job.id).eq("state", "processing").eq("updated_at", job.updated_at).select("id").maybeSingle();
      if (error) throw error;
      if (claimed) schedule(advanceProvider(job, key).then((result) => result.body?.cancel()));
    }
  }
}

async function runBackground() {
  const tasks: Promise<unknown>[] = [];
  const schedule = (task: Promise<unknown>) => {
    tasks.push(task.catch(() => console.error("transcript_background_step_failed")));
  };
  const key = polzaKey();
  const scans = await Promise.allSettled([
    key ? tickTranscriptions(key, schedule) : Promise.resolve(),
    key ? tickSummaries(db, key, schedule) : Promise.resolve(),
    tickDeliveries(db, Deno.env.get("FAMILY_BOT_TOKEN") ?? "", Deno.env.get("FAMILY_BOT_OWNER_ID") ?? ""),
    cleanupExpiredUploads(),
  ]);
  for (const result of scans) if (result.status === "rejected") console.error("transcript_background_scan_failed");
  await Promise.all(tasks);
}

async function handle(request: Request) {
  try {
    if (request.method !== "POST") return problem("method", 405);
    const background = request.headers.get("x-transcript-background");
    if (background !== null) {
      if (request.headers.has("origin") || !/^[0-9a-f]{64}$/.test(background)) return problem("forbidden", 403);
      const { data, error } = await db.rpc("verify_transcript_background_secret", { p_secret: background });
      if (error) throw error;
      if (data !== true) return problem("forbidden", 403);
      EdgeRuntime.waitUntil(runBackground());
      return reply({ status: "accepted" }, 202);
    }
    const feature = new URL(request.url).searchParams.get("feature");
    if (feature === "telegram") {
      if (!guestOrigins.has(request.headers.get("origin") ?? "")) return problem("forbidden", 403);
      const hash = await browserHash(request);
      if (!hash) return problem("forbidden", 403);
      if (!request.headers.get("content-type")?.includes("application/json")) return problem("invalid_request", 400);
      const body = await readAction<{ action?: unknown; code?: unknown }>(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) return problem("invalid_request", 400);
      const result = await handleTelegram(db, hash, body.action, body.code);
      return reply(result, result.state.startsWith("invalid") ? 400 : 200);
    }
    const accessHash = await guestHash(request);
    if (feature === "questions") {
      if (!accessHash) return problem("forbidden", 403);
      if (!request.headers.get("content-type")?.includes("application/json")) return problem("invalid_request", 400);
      const body = await readAction<Record<string, unknown>>(request, 48 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body)) return problem("invalid_request", 400);
      const answer = await handleQuestion(db, body, accessHash, () => clientHash(request), polzaKey(), serviceKey);
      return reply(answer.body, answer.status);
    }
    if (feature === "summary") {
      if (!accessHash) return problem("forbidden", 403);
      if (!request.headers.get("content-type")?.includes("application/json")) return problem("invalid_request", 400);
      const body = await readAction<Record<string, unknown>>(request, 768 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body)) return problem("invalid_request", 400);
      const summary = await handleMeetingSummary(db, body, accessHash, await browserHash(request), () => clientHash(request), polzaKey(),
        (task) => EdgeRuntime.waitUntil(task));
      return reply(summary.body, summary.status);
    }
    const hasLegacyHeader = request.headers.has("x-transcription-session");
    const legacy = hasLegacyHeader && await validSession(request);
    if (!accessHash && !legacy) return problem("forbidden", 403);
    if (!request.headers.get("content-type")?.includes("application/json")) return problem("invalid_request", 400);
    const body = await readAction(request);
    if (!body || typeof body !== "object") return problem("invalid_request", 400);
    if (body.action === "health" && legacy) return reply({ status: "ok", providerConfigured: Boolean(polzaKey()) });
    if (typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.id)) {
      return problem("invalid_request", 400);
    }
    if (body.action === "prepare") return await prepare(body.id, body, request, accessHash);
    if (!["submit", "status", "prepare_part", "resume", "source"].includes(body.action ?? "")) {
      return problem("invalid_request", 400);
    }
    let job = await readJob(body.id);
    if (!job) return problem("job_missing", 404);
    if (job.access_hash === null && legacy && accessHash) {
      const { data, error } = await db.from("transcription_jobs")
        .update({ access_hash: accessHash, client_hash: await clientHash(request) })
        .eq("id", job.id).is("access_hash", null).select("*").maybeSingle();
      if (error) throw error;
      job = data as Job | null ?? await readJob(body.id);
      if (!job) return problem("job_missing", 404);
    }
    if (job.access_hash !== accessHash || (!job.access_hash && !legacy)) return problem("forbidden", 403);
    if (body.action === "prepare_part") return await preparePart(job, body);
    if (body.action === "resume") return await resume(job);
    if (body.action === "source") return await sourceRecording(job);
    return body.action === "submit" ? await submit(job, await browserHash(request)) : await getStatus(job);
  } catch (error) {
    if (error instanceof SyntaxError) return problem("invalid_request", 400);
    console.error("transcription_handler_failed");
    return problem("server_error", 500);
  }
}
Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) return problem("forbidden", 403);
  const response = request.method === "OPTIONS" ? new Response(null, { status: 204 }) : await handle(request);
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "apikey, content-type, x-transcription-job, x-transcription-session, x-transcription-proof, x-transcription-browser");
    response.headers.set("Vary", "Origin");
  }
  return response;
});
