// Ranking for the jump palette.
//
// Subsequence matching rather than substring, because the point of a palette is
// that "pgest" finds "Pencil gestures" — you type what you remember, not what
// is written. Scoring favours letters that land consecutively and letters that
// land at the start of a word, which is what makes an acronym-ish query rank
// the thing you meant above an accidental scatter of the same letters.

export type Scored<T> = { item: T; score: number };

/** Higher is better. `null` means the query is not present at all. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (!t) return null;

  let score = 0;
  let qi = 0;
  let run = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      run = 0;
      continue;
    }
    run += 1;
    // A letter continuing a run is worth more than an isolated one.
    score += 1 + run;
    // A letter starting a word is worth a lot more: it is what people aim at.
    if (ti === 0 || /[\s\-_/.,:]/.test(t[ti - 1])) score += 6;
    qi += 1;
  }

  if (qi < q.length) return null;
  // Among equal matches, prefer the shorter target — it is the more specific one.
  return score - t.length * 0.05;
}

/** Score, drop misses, sort best first, and cap the list. */
export function rank<T>(query: string, items: T[], textOf: (item: T) => string, limit = 8): T[] {
  const scored: Scored<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, textOf(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
