function normalized(text: string) {
  return text.normalize("NFC").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function escapePattern(text: string) {
  return text.replace(/[.*+?^\x24{}()|[\]\\]/g, "\\$&");
}

export function containsLiteral(source: string, value: string) {
  const needle = normalized(value);
  if (!needle) return false;
  return new RegExp("(?<![\\p{L}\\p{N}-])" + escapePattern(needle) + "(?![\\p{L}\\p{N}-])", "u").test(normalized(source));
}

export function confirmedParticipant(transcript: string, name: string) {
  if (!name || /^спикер(?:\s+\d+|\s+не определ[её]н)?$/iu.test(name)) return false;
  const label = escapePattern(normalized(name));
  const boundary = "(?![\\p{L}\\p{N}-])";
  const lines = transcript.split(/\r?\n/).map((line) => normalized(line).replace(/[*_\x60]/g, ""));
  const speakerPatterns = [
    // Web export header, ordinary speaker prefix and explicit participant list.
    "^\\s*(?:\\[?\\d{1,2}:\\d{2}(?::\\d{2})?\\]?\\s*[·—:|-]?\\s*)?" + label + "\\s*(?::|$)",
    "(?:^|[:.!?]\\s+)(?:меня зовут|я)\\s*(?:[-—]\\s*)?" + label + boundary,
    "^(?:участники|присутствуют)\\s*:\\s*(?:[^;,:]+[,;]\\s*)*" + label + "(?:\\s*[,;.]|$)",
    "^(?:спикер\\s+\\d+\\s*:\\s*)?" + label + "\\s*,\\s+(?:привет|здравствуйте|добрый|расскажи|расскажите|ответь|ответьте)" + boundary,
  ].map((pattern) => new RegExp(pattern, "u"));
  return lines.some((line) => speakerPatterns.some((pattern) => pattern.test(line)));
}

function replacementFor(name: string, source: string) {
  if (containsLiteral(source, name)) return name;
  const parts = name.split(/\s+/);
  while (parts.length > 1) {
    parts.pop();
    const shorter = parts.join(" ");
    if (containsLiteral(source, shorter)) return shorter;
  }
  return "участник";
}

const properName = "(?:\\p{Lu}[\\p{Ll}]+(?:[-‑]\\p{Lu}[\\p{Ll}]+)?)";
const fullNamePattern = new RegExp("(?<![\\p{L}\\p{N}])" + properName +
  "(?:[ \\t]+" + properName + "){1,2}(?![\\p{L}\\p{N}])", "gu");

export function groundText(text: string, source: string, proposedNames: string[] = []): string {
  let safe = text;
  const unsupported = [...new Set(proposedNames)].filter((name) => name && !containsLiteral(source, name))
    .sort((left, right) => right.length - left.length);
  for (const name of unsupported) {
    const match = new RegExp("(?<![\\p{L}\\p{N}-])" + escapePattern(name) + "(?![\\p{L}\\p{N}-])", "giu");
    safe = safe.replace(match, (original) => replacementFor(original, source));
  }
  // Also check a bare full name when the model has omitted it from its structured person mentions.
  return safe.replace(fullNamePattern, (name) => replacementFor(name, source));
}

export function groundedOwner(name: string, evidence: string, transcript: string) {
  if (!name || !evidence || !containsLiteral(transcript, evidence) || !containsLiteral(evidence, name)) return null;
  return name;
}
