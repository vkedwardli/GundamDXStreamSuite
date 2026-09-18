// Measure text with the actual overlay font. Work runs once per message, not per frame.
const graphemeSegmenter = new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });
const closingPunctuation = /^[，。！？；：、,.!?;:）)」』】》]$/u;
const phraseEnding = /^[，。！？；、,.!?;]$/u;
const englishLetter = /^[a-z]$/i;

export function paginateCaption(text, measure, maxWidth = 1760) {
  const characters = Array.from(
    graphemeSegmenter.segment(String(text).replace(/\r\n?/g, "\n").trim()),
    ({ segment }) => segment,
  );
  const lines = [];
  let start = 0;

  while (start < characters.length) {
    while (start < characters.length && /^\s+$/u.test(characters[start])) start++;
    if (start === characters.length) break;

    let end = start;
    while (
      end < characters.length &&
      characters[end] !== "\n" &&
      measure(characters.slice(start, end + 1).join("")) <= maxWidth
    ) end++;

    // A grapheme must always make progress, including unusually wide custom fonts.
    if (end === start) end++;
    let cut = end;
    if (end < characters.length && characters[end] !== "\n") {
      // Prefer a phrase break near the end of the line over breaking mid-phrase.
      for (let index = end - 1; index >= start + Math.floor((end - start) / 2); index--) {
        if (phraseEnding.test(characters[index])) { cut = index + 1; break; }
      }

      // Keep English words together where they fit on a fresh line.
      if (cut === end && englishLetter.test(characters[end - 1]) && englishLetter.test(characters[end])) {
        let wordStart = end - 1;
        while (wordStart > start && englishLetter.test(characters[wordStart - 1])) wordStart--;
        if (wordStart > start) cut = wordStart;
      }

      // Move the preceding character too, so a line doesn't begin with a comma/full stop.
      if (cut > start + 1 && closingPunctuation.test(characters[cut])) cut--;
    }

    lines.push(characters.slice(start, cut).join("").trimEnd());
    start = cut;
  }

  const pages = [];
  for (let index = 0; index < lines.length; index += 2) {
    pages.push(lines.slice(index, index + 2));
  }
  return pages.length ? pages : [[""]];
}
