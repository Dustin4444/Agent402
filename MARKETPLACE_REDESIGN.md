# Marketplace terminal: before and after

## What changed and why

The chain market pages (`/base`, `/solana`, `/polygon`, ...) were laid out as
prose. Body copy at 15-21px, generous vertical rhythm, three large metric cards
with 46px bar charts, and a roster of soft-edged seller cards capped at 100
rows. That is a good shape for a paragraph and a poor one for a market: the
question a visitor actually arrives with is "who is settling on this rail, how
do they compare, and which one do I want", and answering it meant scrolling
past cards, one seller at a time, with the mouse.

The terminal answers that question in one screen: every seller as one dense
comparable row, sortable by any numeric column, searchable as you type,
navigable entirely from the keyboard, with the selected seller's 30-day series
drawn beside its totals.

| | Before | After |
|---|---|---|
| Seller presentation | cards, ~72px each | 26px rows, 7 columns |
| Sellers visible without scrolling | ~6 | ~22 |
| Sellers rendered per page | 100 (hard cap) | 400, windowed past 150 |
| Roster transfer cost | 100 cards | 400 rows, 18KB gzipped |
| Comparing two sellers | scroll between cards | adjacent rows, aligned digits |
| Sorting | none on chain pages | any numeric column, click or digit key |
| Search | none on chain pages | incremental, `/` to focus |
| Keyboard | tab through links | `j/k`, `g/G`, `/`, `Enter`, digits, `?` |
| Trend | 46px bar chart, no direction | sparkline + signed delta per metric |
| Scan state | a sentence under the charts | status bar cell, always visible |
| Unknown trend | shown as a flat bar | shown as `--` |

## Design tokens

The palette is **Deepwater**, defined in `src/ledger-chrome.js` in both themes
and used through `var(--t-*)` only. No file in this surface carries a literal
hex; `scripts/test-terminal-tokens.js` fails the build for one, because a
hardcoded colour in a grid rule survives review and then renders invisible in
whichever theme the author did not look at.

**Why it looks like this.** The two terminal cliches are amber-on-black
(Bloomberg) and phosphor-green-on-black (VT100). Both are warm-or-green
monochromes on pure black. Deepwater is deliberately neither: a cool,
low-chroma blue-slate base, because pure black halates on OLED and is not what
a real desk uses, with a cyan primary, a violet reserved for live and
attention, and direction carried in mint and coral rather than green and red so
it stays legible under deuteranopia and is far less garish at this density.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--t-bg` | `#EEF2F6` | `#0A0E14` | terminal ground |
| `--t-panel` | `#FFFFFF` | `#0F141C` | panel surface |
| `--t-panel-2` | `#F5F8FB` | `#141B24` | headers, zebra |
| `--t-rule` | `#D4DDE6` | `#1E2733` | panel separators |
| `--t-rule-2` | `#BCC8D4` | `#2A3542` | emphasis rules, inputs |
| `--t-ink` | `#0E1721` | `#DCE4EE` | figures and primary text |
| `--t-ink-dim` | `#46566A` | `#8A97A8` | secondary text |
| `--t-ink-faint` | `#5A6B7F` | `#7C8AA0` | labels, row index |
| `--t-cyan` | `#0E6F78` | `#4FD1D9` | primary accent, selection |
| `--t-violet` | `#5B3FBF` | `#A78BFA` | live / cursor |
| `--t-up` | `#0F7A54` | `#6EE7A8` | rising |
| `--t-down` | `#B4402F` | `#FF8A7A` | falling |
| `--t-warn` | `#8A5A12` | `#F5C97B` | capped or unavailable scan |
| `--t-sel` / `--t-sel-edge` | teal 10% / `#0E6F78` | cyan 14% / `#4FD1D9` | selected row |
| `--t-grid` | ink 5% | ink 5% | row hairlines, bar track |
| `--t-row-h` | `26px` | `26px` | the row grid (local to `.t-wrap`) |

**Contrast is computed, not eyeballed.** Every ink above clears WCAG AA 4.5:1
against all three surfaces in both themes. 4.5 and not the relaxed 3:1
large-text threshold, because the terminal sets text at 10-12px. The worst case
in the whole palette is `--t-up` on `--t-bg` in light at 4.75:1. Density is
exactly where contrast normally gets given away, so the guard recomputes it
from the token values on every run rather than trusting a hex.

Type is `--font-mono` throughout with `font-variant-numeric: tabular-nums` and
`zero`, because the entire point of a column of numbers is that the digits line
up and a zero is not an O.

## Components

All of it is in `src/market-terminal.js`, server-rendered:

- **Ticker** (`terminalTicker`) - the busiest sellers the page already lists,
  with their volume and, for the seller in scope, a real direction derived from
  its own daily series. A seller we hold no series for gets no arrow rather
  than a fabricated one. CSS marquee, pauses on hover and focus, and stops dead
  under `prefers-reduced-motion`.
- **Roster** (`terminalRoster`) - `role="table"`, seven columns, a routable
  dot, and a share-of-busiest bar. Every row is a real link carrying its own
  numbers as `data-*`.
- **Metrics** (`terminalMetrics`) - transactions, volume and buyers, each with
  a signed delta and a sparkline.
- **Sparkline** (`sparkline`) - inline SVG, no library and no network, drawn in
  `currentColor` so direction colours it and the theme switch is free.
  `aria-hidden`, because the figure beside it is the accessible value.
- **Status bar** (`terminalStatusBar`) - rail, asset, seller count, scope,
  scan state, window, and the `?` hint.
- **Help** (`terminalHelp`) - the shortcut list, server-rendered and hidden, so
  it is in the DOM and findable rather than built by script.

## Keyboard

`j`/`↓` next, `k`/`↑` previous, `g`/`G` first and last, `/` search, `Enter`
open, `3`-`6` sort by that column, `t` switch theme, `Esc` clear or close, `?`
help. Nothing fires while focus is in a text field.

## Progressive enhancement

The server renders every row, the selection and every number. With
`assets/js/market-terminal.js` absent, blocked or broken, the page is still a
complete, readable, navigable market, because the rows are real links and the
figures are already on screen. The script never fetches, never assigns
`innerHTML`, and never derives a figure the server did not already compute; it
only decides which of the existing rows are visible and in what order. Both
properties are asserted, not assumed.

Windowing engages past 150 rows and is otherwise off, because under that the
browser handles the whole list faster than the script can manage a window and
the simpler path has fewer ways to be wrong. The one trap it handles explicitly:
a windowed row is `display:none` and cannot take focus, so keyboard movement
scrolls the row into the window and repaints **before** focusing it.

Zebra striping switches source when the script takes over. With it off, rows
sit in DOM order and `nth-child` is correct; once the script sorts or filters,
DOM position no longer equals visible position, so it stamps `.is-odd` and the
table gets `data-t-js`. The two rules are mutually exclusive rather than one
overriding the other.

CSP: `script-src` carries no `'unsafe-inline'`, so there is no inline script in
this surface at all. The behaviour is a real file under `script-src 'self'`.

## Honesty

A dense grid makes it easy to render a number that is not one. The surface
refuses in three places, each pinned by a test:

- A **capped scan** reads as a floor: `SCAN CAPPED / FLOOR` in the status bar
  and `30,253+` in the metric, never a bare total.
- A **failed scan** says `SCAN UNAVAILABLE` rather than showing zero.
- A series **too short to have a direction** renders `--`, not `0%`.
  `trendOf` returns `null` for no data, too few points, and an all-zero series,
  because an absent trend is not a trend of nothing.

`compactUsd` keeps four decimals under a dollar, so a $0.001 rail never reads
`$0.00`.

## What is not done

The terminal is the index; the per-seller roster still renders beneath it and
carries the disclosures a column cannot: the leaderboard join, collapsed
sibling endpoints (`+N more`), the MPP badge, dispatch eligibility and its
legend. Removing it dropped ten of those at once, which the market page gate
caught. Folding them into the terminal rows is the next step, and until that is
done deleting the roster would quietly lose them.

The all-chains `/marketplace` view is unchanged; only the per-chain pages carry
the terminal so far.

## Tests

`scripts/test-terminal-tokens.js`, 57 assertions, offline, in the `test-unit-d`
lane. Controls run first: `contrast()` must compute 21:1 for black on white and
1:1 for a colour on itself, and the token extractor must read a known token out
of both theme blocks, so a clean palette result is only believed once the maths
has been shown to work.

Seven mutations killed: a literal hex in a grid rule, a token defined in one
theme only, an ink dimmed below AA, escaping dropped from the host cell,
`trendOf` inventing a direction for no data, a capped total losing its floor
marker, and the behaviour script gaining a network call.
