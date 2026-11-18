import type { SupabaseClient } from "npm:@supabase/supabase-js@2.58.0";
import type { Segment } from "./gemini.ts";
import { formatMeetingSummary } from "./summary-format.ts";

export type DeliveryKind = "transcript" | "summary";
type Delivery = {
  kind: DeliveryKind;
  job_id: string;
  binding_id: string;
  state: "pending" | "sending";
  attempts: number;
  updated_at: string;
};
type Outcome = {
  state: "pending" | "sent" | "failed" | "unknown" | "cancelled";
  next_at?: string;
  telegram_message_id?: number;
};

export async function hashSecret(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function browserHash(request: Request) {
  const value = request.headers.get("x-transcription-browser") ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? await hashSecret(value) : null;
}

export async function handleTelegram(
  db: SupabaseClient, hash: string, action: unknown, value: unknown, now = new Date(),
) {
  if (action === "link") {
    const input = typeof value === "string" ? value.toLowerCase().replace(/[\s-]/g, "") : "";
    if (!/^[0-9a-f]{24}$/.test(input)) return { state: "invalid_code" };
    const { data, error } = await db.rpc("link_transcript_telegram", {
      p_browser_hash: hash, p_code_hash: await hashSecret(input),
    });
    if (error) throw error;
    return { state: data === true ? "linked" : "invalid_code" };
  }
  if (action === "unlink") {
    const { error } = await db.from("transcript_telegram_bindings").update({ revoked_at: now.toISOString() })
      .eq("browser_hash", hash).is("revoked_at", null);
    if (error) throw error;
    return { state: "unlinked" };
  }
  if (action !== "status") return { state: "invalid_request" };
  const { data, error } = await db.from("transcript_telegram_bindings").select("id")
    .eq("browser_hash", hash).is("revoked_at", null).maybeSingle();
  if (error) throw error;
  return { state: data ? "linked" : "unlinked" };
}

export async function deliveryStatus(
  db: SupabaseClient, kind: DeliveryKind, job: { id: string; telegram_binding_id: string | null },
) {
  if (!job.telegram_binding_id) return "disabled";
  const { data, error } = await db.from("transcript_telegram_deliveries").select("state")
    .eq("kind", kind).eq("job_id", job.id).maybeSingle();
  if (error) {
    console.warn("transcript_delivery_status_failed");
    return "unavailable";
  }
  return data?.state ?? "waiting";
}

export function safeRecordingName(value: unknown) {
  return typeof value === "string"
    ? value.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180)
    : "";
}

function markdown(value: string) {
  return value.replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\*\x60_[\]]/g, "\\$&").replace(/^(#{1,6}|[-+]|\d+\.)\s/, "\\$&");
}

function timestamp(seconds: number) {
  const elapsed = Math.floor(Math.max(0, seconds));
  return [Math.floor(elapsed / 3600), Math.floor(elapsed / 60) % 60, elapsed % 60]
    .map((part) => String(part).padStart(2, "0")).join(":");
}

export function makeTranscript(name: string | null, duration: number | null, segments: Segment[]) {
  const title = safeRecordingName(name).replace(/\.[a-z0-9]+$/i, "") || "Расшифровка";
  const speakers = new Map<string, number>();
  const lines = ["# " + markdown(title), ""];
  if (typeof duration === "number") lines.push("Длительность — " + timestamp(duration), "");
  for (const part of segments) {
    let speaker = "Спикер не определён";
    if (part.speaker) {
      if (!speakers.has(part.speaker)) speakers.set(part.speaker, speakers.size + 1);
      speaker = "Спикер " + speakers.get(part.speaker);
    }
    lines.push("**" + timestamp(part.start) + " · " + speaker + "**", "", markdown(part.text), "");
  }
  return { name: title + ".md", content: lines.join("\r\n").trimEnd() + "\r\n" };
}

type Document = ReturnType<typeof makeTranscript>;
async function loadDocument(db: SupabaseClient, delivery: Delivery): Promise<Document | null> {
  if (delivery.kind === "summary") {
    const { data, error } = await db.from("meeting_summaries").select("result,created_at")
      .eq("id", delivery.job_id).eq("state", "completed").maybeSingle();
    if (error) throw error;
    if (!data?.result || Date.now() - Date.parse(data.created_at) > 86_400_000) return null;
    const title = safeRecordingName(data.result.title) || "Встреча";
    return { name: "Саммори — " + title + ".md", content: formatMeetingSummary(data.result) };
  }
  const { data, error } = await db.from("transcription_jobs")
    .select("original_name,duration_seconds,provider_result_duration,segments")
    .eq("id", delivery.job_id).eq("state", "completed").maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return makeTranscript(data.original_name, data.duration_seconds ?? data.provider_result_duration, data.segments);
}

export async function sendDocument(
  token: string, chat: string, document: Document, attempts: number, now = Date.now(),
): Promise<Outcome> {
  const body = new FormData();
  body.set("chat_id", chat);
  body.set("document", new Blob([document.content], { type: "text/markdown" }), document.name);
  try {
    const target = "https://api.telegram.org/bot" + token + "/sendDocument";
    const multipart = new Request(target, { method: "POST", body });
    const response = await fetch(target, {
      method: "POST",
      headers: multipart.headers,
      body: await multipart.arrayBuffer(),
      signal: AbortSignal.timeout(40_000),
      redirect: "error",
    });
    const result = await response.json().catch(() => null);
    const id = result?.result?.message_id;
    if (response.ok && result?.ok === true && Number.isSafeInteger(id)) {
      return { state: "sent", telegram_message_id: id };
    }
    if (result?.ok === false && result?.error_code === 429) {
      const delay = Number(result.parameters?.retry_after);
      const seconds = Number.isFinite(delay) ? Math.max(delay, 10) : 60;
      return attempts < 4 ? { state: "pending", next_at: new Date(now + seconds * 1000).toISOString() }
        : { state: "failed" };
    }
    if (result?.ok === false && [400, 401, 403, 404, 413].includes(result.error_code)) return { state: "failed" };
    console.warn("transcript_document_unconfirmed", response.status,
      typeof result?.error_code === "number" ? result.error_code : "no_error_code");
    return { state: "unknown" };
  } catch (error) {
    console.warn("transcript_document_transport_failed", error instanceof Error ? error.name : "unknown");
    return { state: "unknown" };
  }
}

async function deliver(db: SupabaseClient, item: Delivery, token: string, owner: string) {
  const updated = new Date().toISOString();
  const update = (patch: Record<string, unknown>, state: Delivery["state"], expected: string) =>
    db.from("transcript_telegram_deliveries").update({ ...patch, updated_at: new Date().toISOString() })
      .eq("kind", item.kind).eq("job_id", item.job_id).eq("state", state).eq("updated_at", expected)
      .select("updated_at").maybeSingle();
  if (item.state === "sending") {
    const { error } = await update({ state: "unknown" }, "sending", item.updated_at);
    if (error) throw error;
    return;
  }
  // Validate the result and destination before locking an outgoing network attempt.
  const document = await loadDocument(db, item);
  const { data: claim, error } = await update({
    state: "sending", attempts: item.attempts + 1, next_at: new Date(Date.parse(updated) + 60_000).toISOString(),
  }, "pending", item.updated_at);
  if (error) throw error;
  if (!claim) return;
  let outcome: Outcome = { state: "failed" };
  try {
    if (document && token && /^\d+$/.test(owner)) {
      const [profile, link] = await Promise.all([
        db.from("family_bot_profiles").select("owner_id").eq("owner_id", owner).eq("chat_id", owner)
          .eq("active", true).maybeSingle(),
        db.from("transcript_telegram_bindings").select("chat_id").eq("id", item.binding_id).eq("chat_id", owner)
          .is("revoked_at", null).maybeSingle(),
      ]);
      if (profile.error || link.error) {
        outcome = item.attempts < 3
          ? { state: "pending", next_at: new Date(Date.now() + 60_000).toISOString() }
          : { state: "failed" };
      } else {
        outcome = profile.data && link.data
          ? await sendDocument(token, owner, document, item.attempts + 1)
          : { state: "cancelled" };
      }
    }
  } finally {
    const saved = await update(outcome, "sending", claim.updated_at);
    if (saved.error) throw saved.error;
  }
}

export async function tickDeliveries(db: SupabaseClient, token: string, owner: string) {
  const { data, error } = await db.from("transcript_telegram_deliveries")
    .select("kind,job_id,binding_id,state,attempts,updated_at").in("state", ["pending", "sending"])
    .lte("next_at", new Date().toISOString()).order("next_at").limit(2);
  if (error) throw error;
  for (const row of data as Delivery[]) {
    try {
      await deliver(db, row, token, owner);
    } catch {
      console.error("transcript_delivery_worker_failed");
    }
  }
}
