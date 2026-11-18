import type { Segment } from "./gemini.ts";
import type { MeetingSummary } from "./summary-format.ts";

export const summaryValidity = 86_400_000;
export const maxSummaryRevisions = 30;
const maxSourceCharacters = 42_000;

export type Source = { id: number; text: string; timecode: string | null; speaker?: string };
export type Citation = { quote: string; timecode: string | null; speaker?: string };
export type Edit = { field: string; before: string; after: string; fromUser: boolean };
export type Revision = { id: string; result: MeetingSummary };

export function clean(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function textKey(text: string) {
  return text.normalize("NFC").toLocaleLowerCase("ru").replace(/ё/g, "е");
}

function contains(source: string, phrase: string) {
  const needle = textKey(phrase).replace(/[.*+?^\x24{}()|[\]\\]/g, "\\$&");
  return Boolean(needle) && new RegExp("(?<![\\p{L}\\p{N}])" + needle + "(?![\\p{L}\\p{N}])", "u").test(textKey(source));
}

export function recordingSource(segments: Segment[], suppliedNames: unknown): Source[] {
  const names = suppliedNames && typeof suppliedNames === "object"
    ? suppliedNames as Record<string, unknown> : {};
  const known = new Map<string, string>();
  for (const segment of segments) {
    if (segment.speaker && !known.has(segment.speaker)) {
      known.set(segment.speaker,
        (Object.hasOwn(names, segment.speaker) ? clean(names[segment.speaker], 80) : "") ||
        "Спикер " + (known.size + 1));
    }
  }
  return segments.flatMap((segment, index) => {
    const text = clean(segment.text, 6000);
    if (!text) return [];
    const seconds = Math.floor(segment.start);
    const timecode = Number.isFinite(seconds) && seconds >= 0
      ? [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map((part) => String(part).padStart(2, "0")).join(":") : null;
    return [{ id: index + 1, text, timecode, speaker: segment.speaker ? known.get(segment.speaker) : undefined }];
  });
}

export function importedSource(blocks: string[]): Source[] {
  const source: Source[] = [];
  const timestamp = /^(?:\*{1,2})?\[?(\d{1,3}:\d{2}(?::\d{2})?)\]?(?:\s*(?:[·–—-]\s*)?)?/u;
  let nextTime: string | null = null;
  for (const line of blocks.join("\n").split(/\r?\n/)) {
    const text = clean(line, 180_000);
    if (!text) continue;
    const match = text.match(timestamp);
    const remainder = match ? text.slice(match[0].length).trim() : text;
    if (match && (!remainder || /^(?:Спикер|Участник)\s+\d+\*{0,2}$/iu.test(remainder) || /\*\*$/.test(remainder))) {
      nextTime = match[1];
      continue;
    }
    const timecode = match?.[1] ?? nextTime;
    nextTime = null;
    // Keep long paragraphs available to ranking, even when imported on one line.
    const pieces = remainder.match(/.{1,1800}(?:\s+|$)|.{1,1800}/gu) ?? [];
    for (const piece of pieces) {
      if (piece.trim()) source.push({ id: source.length + 1, text: piece.trim(), timecode });
    }
  }
  return source;
}

export function selectSource(all: Source[], question: string): { entries: Source[]; limited: boolean } {
  const token = (text: string) => textKey(text).match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const stems = new Set(token(question).map((value) => value.slice(0, 5)));
  const total = all.reduce((sum, item) => sum + item.text.length + 64, 0);
  if (total <= maxSourceCharacters) return { entries: all, limited: false };
  const weighted = all.map((item, index) => ({
    item,
    index,
    weight: [...new Set(token((item.speaker ?? "") + " " + item.text).map((value) => value.slice(0, 5)))]
      .filter((value) => stems.has(value)).length,
  })).sort((a, b) => b.weight - a.weight || a.index - b.index);
  const entries = new Map<number, Source>();
  let size = 0;
  for (const ranked of weighted) {
    for (const candidate of [ranked.item, all[ranked.index - 1], all[ranked.index + 1]]) {
      if (!candidate || entries.has(candidate.id) || size + candidate.text.length + 64 > maxSourceCharacters) continue;
      entries.set(candidate.id, candidate);
      size += candidate.text.length + 64;
    }
  }
  return { entries: [...entries.values()].sort((a, b) => a.id - b.id), limited: entries.size !== all.length };
}

export function verifiedCitations(source: Source[], supplied: unknown): Citation[] {
  if (!Array.isArray(supplied)) return [];
  const byId = new Map(source.map((entry) => [entry.id, entry]));
  const accepted: Citation[] = [];
  for (const item of supplied.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const entry = byId.get(item.id);
    const quote = clean(item.quote, 500);
    if (!entry || quote.length < 8) continue;
    const index = entry.text.indexOf(quote);
    if (index < 0 || accepted.some((citation) => citation.quote === quote && citation.timecode === entry.timecode)) continue;
    accepted.push({ quote: entry.text.slice(index, index + quote.length), timecode: entry.timecode, speaker: entry.speaker });
  }
  return accepted;
}

function fieldAt(summary: MeetingSummary, field: string): { previous: string; update: (value: string) => void } | null {
  if (field === "title" || field === "date") {
    return { previous: summary[field] ?? "", update: (value) => { summary[field] = value; } };
  }
  const [section, itemNumber, attribute, extra] = field.split(".");
  const index = /^\d{1,2}$/.test(itemNumber ?? "") ? Number(itemNumber) : -1;
  if (index < 0 || extra !== undefined) return null;
  if (section === "participants" && attribute === undefined && index < summary.participants.length) {
    return { previous: summary.participants[index], update: (value) => { summary.participants[index] = value; } };
  }
  if ((section === "decisions" || section === "thoughts" || section === "questions") && attribute === "text") {
    const bullet = summary[section][index];
    if (bullet) return { previous: bullet.text, update: (value) => { bullet.text = value; } };
  }
  if (section === "actions" && (attribute === "owner" || attribute === "due" || attribute === "task")) {
    const action = summary.actions[index];
    if (action) return { previous: action[attribute] ?? "", update: (value) => { action[attribute] = value; } };
  }
  return null;
}

export function proposedEdit(
  summary: MeetingSummary, supplied: unknown, citations: Citation[], question: string,
): Edit | null {
  if (!supplied || typeof supplied !== "object") return null;
  const { field: rawField, value } = supplied as Record<string, unknown>;
  const field = clean(rawField, 70);
  const after = clean(value, 400);
  const target = fieldAt(summary, field);
  if (!target || !after || after === target.previous) return null;
  const supported = citations.some((citation) => contains(citation.quote, after));
  const fromUser = !supported && contains(question, after);
  return supported || fromUser ? { field, before: target.previous, after, fromUser } : null;
}

export function applyEdit(summary: MeetingSummary, edit: Edit): MeetingSummary | null {
  const next = structuredClone(summary);
  const target = fieldAt(next, edit.field);
  if (!target || target.previous !== edit.before) return null;
  target.update(edit.after);
  return next;
}
