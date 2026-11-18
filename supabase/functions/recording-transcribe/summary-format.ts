export const maxTranscriptCharacters = 180_000;

export type SummaryBullet = { text: string; highlight?: string | null };
export type SummaryAction = {
  owner: string | null;
  task: string;
  due: string | null;
  highlight?: string | null;
  request?: boolean;
};
export type SummaryNote = { kind: "wording" | "facilitation"; text: string; timecode: string | null };
export type MeetingSummary = {
  title: string;
  date: string | null;
  participants: string[];
  decisions: SummaryBullet[];
  thoughts: SummaryBullet[];
  questions: SummaryBullet[];
  actions: SummaryAction[];
  notes: SummaryNote[];
};

function line(text: string) {
  return text.replace(/<[^>]+>/g, "").replace(/\*+/g, "").replace(/^\s*[#•]+\s*/, "").replace(/\s+/g, " ").trim();
}

function emphasis(value: string, requested?: string | null) {
  const text = line(value);
  const highlight = requested ? line(requested) : "";
  const fallback = text.match(/\d[\d,.]*%?/u)?.[0] ?? text.match(/[\p{L}]{4,}/u)?.[0] ?? text.split(" ")[0];
  const lower = text.toLocaleLowerCase("ru");
  const start = lower.indexOf(highlight.toLocaleLowerCase("ru"));
  const supplied = highlight && highlight.split(" ").length <= 2 && start >= 0 &&
    !/[\p{L}\p{N}]/u.test(text[start - 1] ?? "") && !/[\p{L}\p{N}]/u.test(text[start + highlight.length] ?? "");
  const phrase = supplied ? highlight : fallback;
  if (!phrase) return text;
  const index = supplied ? start : lower.indexOf(phrase.toLocaleLowerCase("ru"));
  if (index < 0) return text;
  return text.slice(0, index) + "**" + text.slice(index, index + phrase.length) + "**" + text.slice(index + phrase.length);
}

export function formatMeetingSummary(result: MeetingSummary) {
  const date = result.date ? " — " + line(result.date) : "";
  const sections = ["📋 " + line(result.title) + date + "\nУчастники: " +
    (result.participants.map(line).filter(Boolean).join(", ") || "не указаны")];
  for (const [heading, entries] of [
    ["✅ Решения", result.decisions],
    ["💡 Ключевые мысли", result.thoughts],
    ["❓ Открытые вопросы", result.questions],
  ] as const) {
    if (entries.length) sections.push(heading + "\n" +
      entries.map((item) => "• " + emphasis(item.text, item.highlight)).join("\n"));
  }
  const ordinary = result.actions.filter((item) => !item.request);
  const asks = result.actions.filter((item) => item.request);
  if (result.actions.length) {
    sections.push("📌 Действия\n" + [...ordinary, ...asks].map((item) => {
      const owner = item.owner ? line(item.owner) : "не определён";
      const deadline = item.due ? line(item.due) : "";
      const hasDeadline = deadline && !/^(?:—|[-–]|не (?:назван[\p{L}]*|указан[\p{L}]*|определ[её]н[\p{L}]*)|нет)$/iu.test(deadline);
      const taskText = hasDeadline ? line(item.task).replace(/[.!?]+$/u, "") : item.task;
      const task = item.request ? "**Запрос** — " + line(taskText) : emphasis(taskText, item.highlight);
      return "• " + owner + ": " + task +
        (hasDeadline ? " → " + deadline : "");
    }).join("\n"));
  }
  return sections.join("\n\n") + "\n";
}
