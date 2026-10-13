/**
 * Vendor feeds sometimes repeat a phrase several times in a row, for example
 * "Abercrombie and Fitch Abercrombie and Fitch Abercrombie and Fitch Away Tonight". Collapse those
 * runs (up to six words) to one copy. Only exact, consecutive, case-insensitive repeats are touched.
 */
const MAX_PHRASE_WORDS = 6;

export function cleanProductTitle(raw: string): string {
  // One pass can leave a shorter repeat behind (a six-word run collapses to two copies), so repeat
  // until the title stops changing.
  let current = collapseRepeats(raw);
  for (let pass = 0; pass < 5; pass++) {
    const next = collapseRepeats(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function collapseRepeats(raw: string): string {
  const words = raw.trim().split(/\s+/).filter((w) => w.length > 0);
  const out: string[] = [];
  let i = 0;

  while (i < words.length) {
    let collapsed = false;
    for (let len = Math.min(MAX_PHRASE_WORDS, Math.floor((words.length - i) / 2)); len >= 1 && !collapsed; len--) {
      const phrase = words.slice(i, i + len).join(" ").toLowerCase();
      let copies = 1;
      let next = i + len;
      while (next + len <= words.length && words.slice(next, next + len).join(" ").toLowerCase() === phrase) {
        copies++;
        next += len;
      }
      // A brand repeated at the start is a feed fault even as two copies. Anywhere else, two copies
      // can be a real name ("Bum Bum", "Cin Cin"), so only three or more copies are collapsed.
      const needed = i === 0 ? 2 : 3;
      if (copies >= needed) {
        out.push(...words.slice(i, i + len));
        i = next;
        collapsed = true;
      }
    }
    if (!collapsed) {
      out.push(words[i]);
      i++;
    }
  }

  return out.join(" ");
}
