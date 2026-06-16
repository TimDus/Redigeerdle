import { test, expect } from "@playwright/test";
import { badTitle, probe, pickedKey, stripTags, cleanPopularTitles, biasedIndex } from "../scripts/pick-daily.mjs";
import { leaksTitle } from "../scripts/lib/leak-filter.mjs";

// Pure-function unit tests for the daily picker (scripts/pick-daily.mjs). No
// browser, no network — these guard the logic that decides which article makes
// a fair puzzle and that no AI hint leaks the answer.

test.describe("badTitle — only clean, fair guessing targets pass", () => {
  for (const ok of ["Golden Snitch", "Harry Potter", "Albus Dumbledore",
                     "Dumbledore's Army", "Spider-Man", "Excalibur"]) {
    test(`accepts "${ok}"`, () => expect(badTitle(ok)).toBe(false));
  }

  for (const bad of [
    "R2-D2",                 // contains a digit
    "1999",                  // numbers only
    "Smith, John",           // comma not allowed
    "Chapter 1",             // chapter prefix (and a digit)
    "Episode IV",            // episode prefix
    "List of spells",        // generic "List of" page
    "Volume 2",              // volume prefix
    "Gallery",               // gallery prefix
    "a".repeat(51),          // longer than 50 chars
    "one two three four five six seven",   // more than 6 words
    "",                      // empty
    "(Parenthetical)",       // doesn't start with a letter
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => expect(badTitle(bad)).toBe(true));
  }
});

test.describe("probe — measures readable paragraph text", () => {
  test("counts only paragraphs over ~40 chars and strips markup", () => {
    const long = "This is a sufficiently long paragraph of body text, well over forty characters.";
    const html = `<p>${long}</p><p>too short</p><div>not a paragraph</div>`;
    const { chars, paras, text } = probe(html);
    expect(paras).toBe(1);                 // only the long <p> counts
    expect(text).toContain("sufficiently long paragraph");
    expect(text).not.toContain("not a paragraph");   // non-<p> content ignored
    expect(chars).toBeGreaterThan(40);
  });

  test("strips tags and [12]-style citation markers", () => {
    expect(stripTags('<b>Hi</b> there<sup>[3]</sup>')).toBe("Hi there");
  });

  test("an article of pure short lines has zero qualifying paragraphs", () => {
    const html = "<p>tiny</p><p>also tiny</p>";
    expect(probe(html).paras).toBe(0);
  });
});

test("pickedKey is wiki + lowercased title (dedup key is case-insensitive)", () => {
  expect(pickedKey("harrypotter.fandom.com", "Golden Snitch"))
    .toBe("harrypotter.fandom.com golden snitch");
  // same article, different title casing → same key, so it dedupes
  expect(pickedKey("zelda.fandom.com", "Master Sword"))
    .toBe(pickedKey("zelda.fandom.com", "MASTER SWORD"));
});

test.describe("cleanPopularTitles — only clean main-namespace titles from Mostrevisions", () => {
  test("keeps ns=0 article titles in order, drops other namespaces and bad titles", () => {
    const results = [
      { ns: 0, title: "Harry Potter", value: "14249" },     // most-edited article — keep
      { ns: 4, title: "Harry Potter Wiki:About", value: "9" }, // project page — drop (ns≠0)
      { ns: 10, title: "Template:Information", value: "8" },   // template — drop (ns≠0)
      { ns: 0, title: "Hermione Granger", value: "7341" },     // article — keep
      { ns: 0, title: "Chapter 1", value: "50" },              // unfair title — drop (badTitle)
      { ns: 0, title: "Anakin Skywalker/Legends", value: "5" }, // slash → drop (badTitle)
    ];
    expect(cleanPopularTitles(results)).toEqual(["Harry Potter", "Hermione Granger"]);
  });

  test("tolerates null / empty input", () => {
    expect(cleanPopularTitles(null)).toEqual([]);
    expect(cleanPopularTitles([])).toEqual([]);
    expect(cleanPopularTitles([{ ns: 0 }])).toEqual([]);   // no title
  });
});

test.describe("biasedIndex — in-range and biased toward the front", () => {
  const withRandom = (val, fn) => {
    const orig = Math.random;
    Math.random = () => val;
    try { return fn(); } finally { Math.random = orig; }
  };

  test("r=0 → index 0; r→1 stays below n; r=0.5 lands in the front quarter (quadratic bias)", () => {
    expect(withRandom(0, () => biasedIndex(100))).toBe(0);
    expect(withRandom(0.9999, () => biasedIndex(100))).toBe(99);   // never reaches n
    expect(withRandom(0.5, () => biasedIndex(100))).toBe(25);      // uniform would give 50
  });

  test("always returns an integer in [0, n) across the whole random range", () => {
    for (const r of [0, 0.1, 0.37, 0.5, 0.75, 0.99, 0.999999]) {
      const i = withRandom(r, () => biasedIndex(40));
      expect(Number.isInteger(i)).toBe(true);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(40);
    }
  });
});

test.describe("leaksTitle — reject AI hints that give the answer away", () => {
  test("passes a vague, spoiler-free hint", () => {
    expect(leaksTitle("Golden Snitch", "A small winged ball that ends a sporting match.")).toBe(false);
  });

  test("catches a hint containing a title word", () => {
    expect(leaksTitle("Golden Snitch", "The golden ball is hard to catch.")).toBe(true);
  });

  test("ignores title words shorter than 3 letters", () => {
    // "of" (2 letters) is filtered out, so a hint using it doesn't count as a leak
    expect(leaksTitle("Of Mice", "A story set on a farm.")).toBe(false);
  });

  test("matches on a substring (conservative — may over-reject)", () => {
    // "cat" is a title word; "category" contains it, so the hint is dropped.
    // Documents the deliberately strict behaviour.
    expect(leaksTitle("A Cat", "This category of animal is common.")).toBe(true);
  });

  // accents / non-Latin: the app supports any-language MediaWiki, so the filter
  // must fold diacritics and match Unicode letters — not just ASCII [a-z].
  test("catches an accented title word regardless of how the hint accents it", () => {
    expect(leaksTitle("Pokémon", "This Pokémon is an electric creature.")).toBe(true);
    expect(leaksTitle("Pokemon", "A Pokémon trainer appears.")).toBe(true);
    expect(leaksTitle("Beyoncé", "Beyonce released a new album.")).toBe(true);
  });

  test("does not leak when an accented title is described in general terms", () => {
    expect(leaksTitle("Pokémon", "A franchise about collectible creatures.")).toBe(false);
  });

  test("catches a non-Latin (Cyrillic/CJK) title word — used to be a silent no-op", () => {
    // ASCII-only matching produced ZERO guard words here, so any hint passed.
    expect(leaksTitle("Война", "Это книга про войну. Война и мир.")).toBe(true);
    expect(leaksTitle("東京タワー", "ランドマークは東京タワーです。")).toBe(true);
  });
});
