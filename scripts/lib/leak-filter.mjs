// Canonical, unit-tested leak filter for AI-generated hints (see
// tests/picker.spec.mjs). A hint "leaks" if it contains any significant (3+
// letter) word of the title, so the player could read the answer from it.
//
// NOTE: the hint Edge Function (supabase/functions/hint/index.ts) runs on Deno
// and is deployed separately, so it carries its OWN copy of this logic. This
// module is the reference — keep the two in sync when you change either.
export const leaksTitle = (title, hint) => {
  const titleWords = (String(title).toLowerCase().match(/[a-z]{3,}/g) || []);
  const low = String(hint).toLowerCase();
  return titleWords.some(w => low.includes(w));
};
