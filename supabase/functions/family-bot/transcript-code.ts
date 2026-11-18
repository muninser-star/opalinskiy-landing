import type { SupabaseClient } from "@supabase/supabase-js";

export function isTranscriptLinkCommand(message: unknown): boolean {
  return typeof message === "string" &&
    /^\/(?:transcript(?:@[A-Za-z0-9_]+)?|start(?:@[A-Za-z0-9_]+)?\s+transcript)\s*$/i.test(message);
}

export async function issueTranscriptCode(db: SupabaseClient, chatId: number) {
  const random = crypto.getRandomValues(new Uint8Array(12));
  const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const code = toHex(random);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  const codeHash = toHex(new Uint8Array(hash));
  const { error } = await db.from("transcript_telegram_codes").insert({ code_hash: codeHash, chat_id: chatId });
  if (error) throw error;
  // Expired codes carry no power and can be removed independently of issuing the new one.
  await db.from("transcript_telegram_codes").delete().lte("expires_at", new Date().toISOString());
  return code.match(/.{6}/g)!.join("-");
}
