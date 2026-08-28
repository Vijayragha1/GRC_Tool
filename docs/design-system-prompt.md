# Compliance Sphere UI: design brief for an AI assistant

Paste this whole file into the model's context before asking it to build or change
any screen in this product. It is written to be pasted, not read for pleasure.

Everything below is taken from `public/app.css` and the shipped views. If you
change the design system, change this file in the same commit or it becomes a
lie that three different models will faithfully reproduce.

---

## 1. What this product is

A delivery record for consulting firms running ISO 27001, ISO 42001, NIST CSF and
DPDPA engagements. The people using it are consultants, engagement managers,
client security leads and external auditors. They are working, not browsing.

The tone that follows from that: **factual, restrained, slightly severe.** The
interface is a professional instrument. It should feel closer to a well-set audit
working paper than to a consumer SaaS dashboard.

Read two real strings from the product and match their register:

> Mandatory ISO 27001 document (clause 6.1.3.d).

> A readiness conclusion for a stated boundary and date, not legal certification.

Neither sells. Neither hedges. Both assume a competent reader.

---

## 2. The rule that matters most

**A status is quiet coloured text. It is not a chip, pill, badge or dot.**

This is written into `app.css` and it is the single most common thing an AI gets
wrong here:

```
/* Status - QUIET TEXT, not a chip. Bold-weight semantic colour in the row,
   no pill chrome, no dot. Removes ~80% of the chip noise that LLM-generated
   SaaS reflexively scatters across every table. */
```

Use `.status` with an `.s-*` modifier:

```html
<span class="status s-implemented">Implemented</span>
```

| Modifier group | Colour | Meaning |
|---|---|---|
| `.s-implemented .s-included .s-done .s-closed .s-verified` | `#15803d` | resolved |
| `.s-partial .s-in_review .s-accepted .s-minor` | `#b45309` | partial |
| `.s-progress .s-in_progress .s-treated` | `#1d4ed8` | moving |
| `.s-not-implemented .s-excluded .s-blocked .s-open .s-major` | `#b91c1c` | failing |
| `.s-na .s-not-assessed .s-undecided .s-todo .s-observation` | `#52525b` | neutral |

`.tag` exists for a genuinely categorical label (applicability "excluded",
severity "major"), with `.tag-neutral .tag-accent .tag-info .tag-success
.tag-warn .tag-danger`. Reach for it rarely. If a table has a chip in every row
of a column, that column should be text.

---

## 3. Tokens

Never hardcode a colour. Every value below already exists as a variable.

**Light**

```
--bg #fbfbf8   --bg-subtle #f6f5ef   --bg-muted #f0eee7   --bg-deep #f2f1ec
--border #ecebe5              --border-strong #d8d6cf
--text #1a1a1a  --text-secondary #6b6b66  --text-tertiary #73736f
--accent #1a1a1a              --accent-soft rgba(26,26,26,0.06)
--sidebar-bg #F2F1EC          --table-head-bg #f1f1ed
--radius 6px                  --radius-sm 6px
```

**Dark** (same names, redefined under `[data-theme="dark"]`)

```
--bg #1c2023   --bg-subtle #202529   --bg-muted #272d31   --bg-deep #15181a
--border #2d3438              --border-strong #3b454b
--text #edf0f1  --text-secondary #b2bbc0  --text-tertiary #909aa0
--accent #a7c4b8
```

The palette is warm cream and charcoal. **The accent is charcoal, not a brand
colour.** Colour in this product carries meaning: green/amber/red/blue mean
resolved/partial/failing/moving. If you introduce a decorative colour you have
broken the one signal the interface has.

**Type**

```
--font-sans     system UI stack
--font-display  system UI Display stack
--font-serif    var(--font-display)   <- resolves to SANS. There is no serif.
```

Never write a literal font family. `font-family: Georgia, serif` on one line makes
that line the only true serif on the page and it reads as a different product.

Scale, all of it:

```
.text-xxs 10px  .text-eyebrow 10.5px  .text-xs 11px  .text-sm 11.5px
.text-base 12px  .text-md 12.5px  .text-lg 13px  .text-xl 14px
```

Figures (counts, scores, percentages) use `var(--font-display)` at 20-34px,
weight 500, with `font-variant-numeric: tabular-nums`.

---

## 4. Components

Use these. Do not invent parallel ones.

| Class | Use |
|---|---|
| `.panel` | the standard container: `--bg`, 1px `--border`, 6px radius, no shadow |
| `.panel-head` | its header strip, 10px 16px, bottom border |
| `.panel-pad` | its body padding, 16px |
| `.page-head` | page title block, flex, wraps |
| `.kpi` / `.kpi-num` | a single figure, 20px display face |
| `table.t` | the standard data table |
| `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-ghost` / `.btn-xs` | actions. Bare `.btn` is deliberately transparent |
| `.meta` | 12px tertiary supporting text |
| `.label` | form field label |
| `.stack-grid` | a grid that collapses on phones (see below) |

**Density is correct.** Panels sit at 12-16px padding, tables at 12px text.
A consultant comparing 93 Annex A controls needs them on one screen. Do not add
whitespace to make it feel calmer; that trades their working memory for air.

---

## 5. Layout conventions specific to this codebase

**Responsive grids.** An inline `grid-template-columns` outranks any media query,
so it can never be made responsive. Views pass the track list as a variable and
the stylesheet owns the property:

```html
<div class="stack-grid" style="--cols:1fr 1fr 1fr 1fr">
<div class="stack-grid" style="--cols:repeat(5,1fr); --cols-sm:1fr 1fr">
```

`.stack-grid` collapses to one column at 760px; `--cols-sm` overrides that where
one column is wrong. Same idea for dropdowns: `.popover-panel` with
`--popover-w:440px`, bounded to the viewport on phones.

**Field width follows the answer.** A headcount gets a 130px input, a name 420px,
prose the full width. Identical full-width boxes for every question is the
clearest signal a form was generated rather than designed.

**Phone floor.** Nothing below 11px. Tap targets 44px (36px for in-row `.btn-xs`,
24px for checkboxes). Form controls 16px font or iOS zooms the page on focus.
Wide tables scroll inside themselves rather than being clipped by a panel.

---

## 6. Hard rules

- **No em dashes anywhere in source or copy.** Enforced by
  `tests/typography.test.js`, which scans both source and rendered HTML. Use a
  comma, a colon, a full stop, or " - ".
- **No gradients.** `app.css` contains zero; the public stylesheet is tested for it.
- **No shadows on panels.** `--shadow-sm` and `--shadow-md` are literally `none`.
  Shadow is reserved for things that float: dropdowns, modals.
- **No emoji in the interface.**
- **No decorative icons.** Icons are functional and monochrome.
- **6px radius.** Not 12, not pill.
- Colour means status. Nothing else may be coloured.

---

## 7. What makes a screen look AI-generated

The user of this codebase has rejected screens with the words "childish", "llmish"
and "vanilla". Every time, it was one of these:

1. **A row of counter tiles that are all zero.** Six KPI cards reading 0, 0, 0,
   0, 0, 0 tells a consultant nothing and eats a band of the page. Show the one
   figure that is moving, or show what to do next.
2. **Chips and pills everywhere.** See section 2.
3. **Three equal bordered cards.** The feature triptych. If three things are
   genuinely parallel, they are a list or a table, not three boxes.
4. **A circled 1-2-3 step list.**
5. **Headlines built on tics.** "X, not Y." "One X, distinct Y." Say the fact.
6. **Adjectives instead of mechanisms.** Not "enterprise-grade governance" but
   "an approved report is a content-addressed snapshot; reassessment opens a new
   record."
7. **Symmetric boxes of equal weight with no hierarchy.** A screen should answer
   where the engagement is, what is blocking it, and what to do next, in that
   order of prominence.
8. **Empty states that occupy as much room as full ones.** Two large panels
   saying "No open actions" and "No open risks" is worse than one quiet line.
9. **Explaining the product to its own user** in a banner on a page they are
   already working in.

---

## 8. Copy

Sentence case. No exclamation marks. No "Oops". Numbers as digits.

Name the mechanism, not the benefit. Where a claim has a source, cite it inline
the way the product already does: "ISO 27001 9.2: this hard gate must pass before
the workspace can be represented as Stage 1 ready."

Button labels are verbs and are exact. Some are asserted by tests, so do not
shorten "Apply filters" to "Apply".

Hint text under a field should tell the consultant what a good answer looks like,
in the firm's own voice:

> Exclusions need justification - "internal HR systems, no customer data" is
> fine, "we just don't want to" is not.

---

## 9. Before you claim you are done

- Every colour is a token; no literal hex in a view.
- Every font is a token; no literal family.
- Statuses are text, not chips.
- No em dash anywhere, including comments.
- The page works at 375px: no horizontal overflow, nothing clipped by a panel,
  no text under 11px.
- It reads as the same product as the screen next to it.
