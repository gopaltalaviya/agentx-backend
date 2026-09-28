# The submission deck

`agentx.pptx` — 10 slides for Monad Metropolis, Track 4.

## Rebuilding it

```bash
node build-deck.cjs          # writes agentx.pptx
python check-geometry.py     # bounds and overlap audit
```

The deck is generated from `build-deck.cjs` rather than edited by hand, so a
changed number is a one-line diff and a rebuild rather than an opaque binary
edit. `.cjs`, because this workspace is `"type": "module"`.

## What is checked, and what is not

| | |
|---|---|
| ✅ Schema, relationships, content types | `validate.py` from the pptx skill — passes |
| ✅ Content and speaker notes | `markitdown agentx.pptx` |
| ✅ Geometry | `check-geometry.py` — nothing past the canvas, nothing inside the 0.5" margin, no text over text |
| ❌ **How it actually looks** | **Not verified.** This machine has no LibreOffice and no `pdftoppm`, so the slides have never been rendered to images |

That last row matters. `pptxgenjs` writes out-of-bounds coordinates instead of
clamping them, which is why the geometry check exists — but a geometry check
cannot see contrast, a line that wrapped badly, or a font that set wider than
expected. **Open it in PowerPoint before presenting it.**

## Content that is deliberately missing

There is **no demo slide and no figure from a live run**, because
`pnpm demo` has never run end to end. A screenshot of a demo that has not
happened would be a lie. Both land the moment a model provider key exists.

## Deck order

| # | Slide | Job it does |
|---|---|---|
| 1 | Cover | Name, one sentence, already on chain |
| 2 | The problem, measured | Xiong et al. 2026 — $0.0027 to move a score |
| 3 | The idea | A review costs exactly what the job cost |
| 4 | How it works | Four on-chain steps; declining is the strategy |
| 5 | Deployed, and settling | Real addresses, real test counts |
| 6 | The risk that matters | Agent-to-agent prompt injection |
| 7 | The honest claim | Bounded, not prevented |
| 8 | Where this sits | ERC-8004 · ERC-8183 · AGENTX |
| 9 | What this does not solve | Volunteered, not discovered |
| 10 | Close | The one line, and the repo links |
