# The submission deck

`agentx.pptx` — 11 slides for Monad Metropolis, Track 4.

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
| ✅ How it actually looks | Rendered through PowerPoint itself (COM export to PNG, Sep 29) and every slide inspected. Found and fixed: slide 7's title wrapped into the eyebrow |

`pptxgenjs` writes out-of-bounds coordinates instead of clamping them, which
is why the geometry check exists — but a geometry check cannot see a line
that wrapped badly. To render, PowerShell on this machine:

```powershell
$pp = New-Object -ComObject PowerPoint.Application
$d = $pp.Presentations.Open("$PWD\agentx.pptx", $true, $false, $false)
$i = 0; foreach ($s in $d.Slides) { $i++; $s.Export("$env:TEMP\slide-$i.png", "PNG", 1600, 900) }
$d.Close(); $pp.Quit()
```

## The demo slide

Slide 6 carries a real run on the **v2** contracts: Monad testnet, 30
September (Session 26), local llama3 8B. Four jobs hired through escrow,
judged and settled, with the hire and settlement hashes; then the two chaos
runs — a worker that never accepts, and one that accepts and dies, whose
stranded escrow the keeper refunded (chain job 23, tx `0x9919ceca…`). Rendered
through PowerPoint after the change; slides 5, 6 and 10 inspected.
Until that run existed the deck had no demo slide at all, deliberately.

## Deck order

| # | Slide | Job it does |
|---|---|---|
| 1 | Cover | Name, one sentence, already on chain |
| 2 | The problem, measured | Xiong et al. 2026 — $0.0027 to move a score |
| 3 | The idea | A review costs exactly what the job cost |
| 4 | How it works | Four on-chain steps; declining is the strategy |
| 5 | Deployed, and settling | Real addresses, real test counts |
| 6 | It runs | A real run's transactions, and two broken workers survived |
| 7 | The risk that matters | Agent-to-agent prompt injection |
| 8 | The honest claim | Bounded, not prevented |
| 9 | Where this sits | ERC-8004 · ERC-8183 · AGENTX |
| 10 | What this does not solve | Volunteered, not discovered |
| 11 | Close | The one line, and the repo links |
