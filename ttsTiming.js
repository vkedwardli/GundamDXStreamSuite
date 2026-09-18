export const CAPTION_HOLD_MS = 3000;
// Includes the 700ms fade, leaving a short clear view of OBS between announcements.
export const CAPTION_GAP_MS = 3000;

export function parseSrt(source) {
  const toMilliseconds = (time) => {
    const [hours, minutes, seconds, milliseconds] = time.split(/[:,.]/).map(Number);
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
  };
  const cues = [];
  for (const block of source.replace(/\r/g, "").split(/\n\s*\n/)) {
    const match = block.match(/(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})[^\n]*\n([\s\S]+)/);
    if (!match) continue;
    const startMs = toMilliseconds(match[1]);
    const endMs = toMilliseconds(match[2]);
    if (endMs > startMs) cues.push({ startMs, endMs, text: match[3].trim() });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

const weight = (text) => Math.max(1, Array.from(text.replace(/[^\p{L}\p{N}]/gu, "")).length);

// Sentence boundaries come from Edge. Breaks within a sentence are estimates;
// proportional positions also tolerate pronunciation substitutions in the audio text.
export function captionPageTimes(pages, cues, durationMs) {
  const weights = pages.map((page) => weight(page.join("")));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const cueWeights = cues.map((cue) => weight(cue.text));
  const cueTotal = cueWeights.reduce((sum, value) => sum + value, 0);
  let consumed = 0;
  let previous = 0;
  return weights.map((pageWeight, page) => {
    const fraction = consumed / total;
    consumed += pageWeight;
    if (page === 0) return 0;
    let time = fraction * durationMs;
    if (cueTotal) {
      let target = fraction * cueTotal;
      for (let index = 0; index < cues.length; index++) {
        if (target < cueWeights[index] || index === cues.length - 1) {
          const cue = cues[index];
          time = cue.startMs + (cue.endMs - cue.startMs) * Math.min(1, target / cueWeights[index]);
          break;
        }
        target -= cueWeights[index];
      }
    }
    previous = Math.max(previous, Math.min(Math.max(0, durationMs - 100), time));
    return previous;
  });
}
