# Legacy: opt-in wide layout / single-column default

> Archived on 2026-06-13. Until this date the **single-column** layout was the
> default and the **wide** (two-column) layout was an opt-in per-device preference
> toggled from Settings → Layout. We flipped that: wide is now the base layout and
> the single column only survives as the `@media (max-width:880px)` collapse.
>
> This file preserves the removed code so the old behaviour can be restored or
> referenced later. It is **not** loaded by the app.

## How it used to work

- `.wrap` was `max-width:760px` (single column).
- `#playarea` / `#controlcol` were `display:contents`, so the play elements behaved
  as direct children of `.wrap` — classic single column, sticky guessbar.
- Adding `.wide` to `.wrap` (from the Settings toggle) turned `#playarea` into a
  two-column grid (article | controls) and widened `.wrap` to `1500px`.
- The choice persisted per-device in `localStorage` under `redigeerdle:wide`
  (`"1"` = on). Applied on boot via `applyWide(isWide())`.

## Removed CSS (was in the `<style>` block)

```css
  /* ---- wide layout (opt-in via Settings; default OFF keeps the single column) ----
     #playarea / #controlcol are display:contents by default, so the play elements
     behave EXACTLY as direct children of .wrap — same order, margins and sticky
     guessbar. Turning on .wrap.wide makes #playarea a two-column grid: the article
     on one side, the guesser + hint tools + guessed-words list on the other (which
     then gets far more vertical room). */
  #playarea, #controlcol { display:contents; }
  .wrap.wide { max-width:1500px; }
  .wrap.wide #playarea {
    display:grid; align-items:start; column-gap:34px;
    grid-template-columns:minmax(0,1fr) minmax(360px,480px);
    grid-template-areas:"article controls";
  }
  .wrap.wide #article { grid-area:article; }
  /* the controls column follows you down the page as the (taller) article scrolls */
  .wrap.wide #controlcol { grid-area:controls; display:flex; flex-direction:column; position:sticky; top:16px; align-self:start; }
  .wrap.wide #controlcol .guessbar { position:static; }   /* the whole column is sticky now */
  .wrap.wide #controlcol .history { max-height:55vh; }
  @media (max-width:880px) {
    .wrap.wide { max-width:760px; }
    .wrap.wide #playarea, .wrap.wide #controlcol { display:contents; }
    .wrap.wide #controlcol .history { max-height:120px; }
  }

  /* (and the base .wrap was:) */
  .wrap { max-width:760px; margin:0 auto; padding:24px 20px 40px; }

  /* (toggle button styling) */
  .wide-toggle { margin-top:4px; }
  .wide-toggle[aria-pressed="true"] { background:var(--ink); color:var(--paper); }
```

## Removed HTML (Settings modal → Layout section)

```html
      <div class="settings-h">Layout</div>
      <div class="opt-d">Use the full screen width — article on one side, your guesses &amp; hints on the other.</div>
      <button id="wideToggle" class="ghost wide-toggle" aria-pressed="false">Wide layout: Off</button>
      <div class="settings-divider"></div>
```

## Removed JS

```js
/* ---- wide layout: a per-device UI preference (localStorage); default OFF keeps
   the classic single-column layout. Toggled from Settings → Layout. ---- */
const WIDE_KEY = "redigeerdle:wide";
function isWide() { try { return localStorage.getItem(WIDE_KEY) === "1"; } catch { return false; } }
function applyWide(on) {
  document.querySelector(".wrap").classList.toggle("wide", on);
  const btn = document.getElementById("wideToggle");
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.textContent = "Wide layout: " + (on ? "On" : "Off");
}
document.getElementById("wideToggle").addEventListener("click", () => {
  const on = !document.querySelector(".wrap").classList.contains("wide");
  try { localStorage.setItem(WIDE_KEY, on ? "1" : "0"); } catch { /* storage blocked — won't persist */ }
  applyWide(on);
});

// in boot():
//   applyWide(isWide());
```
