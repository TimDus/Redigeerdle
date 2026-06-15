// Canonical, unit-tested leak filter for AI-generated hints (see
// tests/picker.spec.mjs). A hint "leaks" if it contains any significant (3+
// letter) word of the title, so the player could read the answer from it.
//
// NOTE: the hint Edge Function (supabase/functions/hint/index.ts) runs on Deno
// and is deployed separately, so it carries its OWN copy of this logic. This
// module is the reference — keep the two in sync when you change either.

// Fold accents/diacritics away and lowercase, so the guard catches a title word
// regardless of how it's accented in the hint ("Pokemon" matches "Pokemon").
// Crucially we then match Unicode LETTERS/NUMBERS (\p{L}\p{N}), NOT just ASCII
// [a-z]: a non-Latin title (Cyrillic, Greek, CJK, ...) used to produce ZERO guard
// words, so the filter was a silent no-op and the model could echo the answer.
const foldText = s => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const leaksTitle = (title, hint) => {
  const titleWords = (foldText(title).match(/[\p{L}\p{N}]{3,}/gu) || []);
  const low = foldText(hint);
  return titleWords.some(w => low.includes(w));
};
