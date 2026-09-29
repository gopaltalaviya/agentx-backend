"""
Builds docs/agentx-status.xlsx — the project tracker as a spreadsheet.

Generated from this script rather than hand-maintained, so it is rebuilt from
PROGRESS.md's facts instead of drifting away from them. Run:

    python build-status-workbook.py

Formulas are written for Excel to evaluate on open. They are NOT recalculated
here: that needs LibreOffice, which this machine does not have, so every
formula cell will read back empty to a non-Excel previewer until Excel opens
it once. They are kept to SUM and COUNTIF for that reason — simple enough to
verify by reading.
"""

from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

OUT = Path(__file__).parent / "agentx-status.xlsx"

INK = "1F2733"
ACCENT = "2F5FA8"
GOOD = "1F7A4D"
WARN = "9A6A00"
BAD = "A32020"
BAND = "F2F5F9"

HEAD_FILL = PatternFill("solid", fgColor=INK)
HEAD_FONT = Font(name="Arial", size=11, bold=True, color="FFFFFF")
BODY_FONT = Font(name="Arial", size=10)
BOLD = Font(name="Arial", size=10, bold=True)
THIN = Side(style="thin", color="D4DAE3")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(vertical="top", wrap_text=True)
TOP = Alignment(vertical="top")


def sheet(wb, title, headers, widths, first=False):
    ws = wb.active if first else wb.create_sheet()
    ws.title = title
    for i, (h, w) in enumerate(zip(headers, widths), start=1):
        c = ws.cell(row=1, column=i, value=h)
        c.fill, c.font, c.border = HEAD_FILL, HEAD_FONT, BORDER
        c.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.row_dimensions[1].height = 26
    ws.freeze_panes = "A2"
    return ws


def rows(ws, data, colors=None):
    """Write rows, banding alternates, and colour a column by keyword."""
    for r, row in enumerate(data, start=2):
        for c, value in enumerate(row, start=1):
            cell = ws.cell(row=r, column=c, value=value)
            cell.font = BODY_FONT
            cell.border = BORDER
            cell.alignment = WRAP if c == len(row) else TOP
            if r % 2 == 0:
                cell.fill = PatternFill("solid", fgColor=BAND)
            if colors and c in colors and isinstance(value, str):
                tone = {"done": GOOD, "blocked": BAD, "open": WARN, "in progress": WARN}.get(
                    value.strip().lower()
                )
                if tone:
                    cell.font = Font(name="Arial", size=10, bold=True, color=tone)
    return ws.max_row


wb = Workbook()

# ── 1. Milestones ─────────────────────────────────────────────────────────
ws = sheet(
    wb,
    "Milestones",
    ["Milestone", "Scope", "Planned", "Status", "Done", "Total", "% complete"],
    [14, 34, 18, 14, 8, 8, 12],
    first=True,
)
milestones = [
    ("M0", "Foundations", "Sep 22-24", "Done", 23, 23),
    ("M1", "Contracts", "Sep 25-28", "Done", 26, 26),
    ("M2", "Backend spine", "Sep 29 - Oct 2", "In progress", 21, 25),
    ("M3", "Agents + MCP", "Oct 3-5", "In progress", 14, 15),
    ("M4", "Frontend", "Oct 6-8", "In progress", 9, 11),
    ("M5", "Harden", "Oct 9-11", "In progress", 6, 7),
    ("M6", "Submit", "Oct 12-13", "In progress", 5, 8),
]
last = rows(ws, milestones, colors={4})
for r in range(2, last + 1):
    c = ws.cell(row=r, column=7, value=f"=IF(F{r}=0,0,E{r}/F{r})")
    c.number_format = "0%"
    c.font, c.border, c.alignment = BODY_FONT, BORDER, TOP

total = last + 1
ws.cell(row=total, column=1, value="TOTAL").font = BOLD
ws.cell(row=total, column=5, value=f"=SUM(E2:E{last})").font = BOLD
ws.cell(row=total, column=6, value=f"=SUM(F2:F{last})").font = BOLD
pct = ws.cell(row=total, column=7, value=f"=IF(F{total}=0,0,E{total}/F{total})")
pct.font, pct.number_format = BOLD, "0%"
for col in range(1, 8):
    ws.cell(row=total, column=col).border = BORDER

# ── 2. Blockers ───────────────────────────────────────────────────────────
ws = sheet(
    wb,
    "Blockers",
    ["ID", "What is blocked", "Blocked by", "Owner", "Since", "Severity", "Notes"],
    [8, 34, 30, 10, 12, 12, 52],
)
rows(
    ws,
    [
        (
            "B6",
            "pnpm demo, M3 done-condition, chaos items, backup video",
            "No model",
            "User",
            "Sep 23",
            "Done",
            "Cleared Sep 29 with local Ollama (llama3 8B), no API quota. The first live runs found sixteen defects on the hire-to-settle path.",
        ),
        (
            "B7",
            "Interface visual verification",
            "Chrome extension not connected",
            "Claude",
            "Sep 23",
            "Done",
            "Rendered Sep 29 with headless Chrome. First render found the API sent no CORS headers, so every page said API unreachable; fixed.",
        ),
        (
            "B8",
            "Deploy + e2e against real hosting",
            "Railway + Vercel accounts",
            "User",
            "Sep 22",
            "Open",
            "Deferred to M5 by the owner's earlier call.",
        ),
        (
            "B10",
            "Verified source on the block explorer",
            "EXPLORER_API_KEY is empty",
            "User",
            "Sep 28",
            "Open",
            "Contracts are deployed but unverified, so an explorer link shows bytecode. The foundry.toml defect that also blocked this is fixed.",
        ),
        (
            "B11",
            "Repos readable by judges",
            "Repos are private",
            "User",
            "-",
            "Open",
            "Must be public by Oct 13; the submission requires a code link.",
        ),
    ],
    colors={6},
)

# ── 3. Tests ──────────────────────────────────────────────────────────────
ws = sheet(
    wb,
    "Tests",
    ["Repo", "Suite", "Tests", "What it covers"],
    [20, 30, 10, 62],
)
tests = [
    ("agentx-contracts", "TaskEscrow", 31, "Job state machine, settlement, fee split, the three permissionless exits"),
    ("agentx-contracts", "AgentAccount", 34, "Spending caps, allowlists, session key lifetime, access control"),
    ("agentx-contracts", "StakeVault", 11, "Bonds per agent id, withdrawal delay, slashing"),
    ("agentx-contracts", "Adversarial", 15, "Hostile sequences against the escrow"),
    ("agentx-contracts", "Guards", 26, "Reverts and boundary conditions"),
    ("agentx-contracts", "Escrow.invariant", 6, "Solvency, lockedTotal, fee bounds, no self-dealing (512k transitions each)"),
    ("agentx-contracts", "MockUSDC", 5, "Test token"),
    ("agentx-backend", "agent-core/orchestrator", 31, "Every failure branch, and the retry of a silent worker with another agent"),
    ("agentx-backend", "api", 30, "Registration, discovery, hiring, idempotent retries, the earned fast path, auth codes"),
    ("agentx-backend", "sdk/client", 29, "Retries, idempotency keys, typed errors, NotAccepted"),
    ("agentx-backend", "agent-core/worker", 26, "Offer loop, decline, triage outage, retrying a transient accept"),
    ("agentx-backend", "agent-core/injection", 23, "Untrusted-content containment; the judge's rating scale"),
    ("agentx-backend", "api/chaos", 23, "Malformed result, daily cap, result shape, on-chain hash"),
    ("agentx-backend", "signer", 32, "AgentAccount routing via execute, caps on- and off-chain, gas, replay, stranded-nonce release, error classification"),
    ("agentx-backend", "db/constraints", 21, "Every documented database guarantee, tried by writing the bad row"),
    ("agentx-backend", "agent-core/fallback", 20, "Provider chain, cached replay, recorders sharing one file"),
    ("agentx-backend", "indexer/replay", 22, "Replay safety, refund reasons, tx hashes, confidence floor, party-checked linking, reorgs"),
    ("agentx-backend", "api/meta", 18, "Network and budget endpoints, the 24h rollover"),
    ("agentx-backend", "mcp/tools", 17, "Tool descriptions, spend warnings, error retryability"),
    ("agentx-backend", "api/runs", 11, "Run lifecycle, durable trace, terminal state"),
    ("agentx-backend", "indexer/loop", 10, "Exponential backoff, recovery, clean shutdown"),
    ("agentx-backend", "signer/keeper", 9, "Which permissionless exit is due, at every deadline boundary"),
    ("agentx-backend", "config/money", 8, "Base-unit formatting and parsing"),
    ("agentx-backend", "sdk/stream", 8, "SSE frames split at every byte offset; a bad frame does not end the stream"),
    ("agentx-backend", "api/identity", 6, "ERC-8004 id verified against the registry before it is stored"),
    ("agentx-backend", "mcp/server", 6, "A real MCP session: schemas, annotations, tool errors"),
    ("agentx-backend", "signer/auth", 6, "SIGNER_TOKEN, loopback-only without one"),
    ("agentx-backend", "api/cors", 5, "A browser on another origin can call the API; credentials stay off"),
    ("agentx-backend", "api/submit", 2, "The API presents the signer token"),
    ("agentx-interface", "lib/api", 7, "formatUnits, including exactness past 2^53"),
]
last = rows(ws, tests)
ws.cell(row=last + 1, column=2, value="TOTAL").font = BOLD
t = ws.cell(row=last + 1, column=3, value=f"=SUM(C2:C{last})")
t.font, t.border = BOLD, BORDER

# ── 4. Defects ────────────────────────────────────────────────────────────
ws = sheet(
    wb,
    "Defects",
    ["Severity", "Defect", "How it was caught", "Status"],
    [12, 62, 34, 12],
)
rows(
    ws,
    [
        ("Critical", "Every escrow job would have been disputed: the API stored the delivery envelope as the result, so good work failed the required-field check", "Auditing docs against the routes", "Fixed"),
        ("Critical", "An indexer restart could manufacture reputation: the bump was not idempotent while replays are routine", "Chaos item 2", "Fixed"),
        ("Critical", "The on-chain commitment was the spec hash, not the result hash, so T4's claim was false", "The same docs audit", "Fixed"),
        ("Critical", "Fee-on-transfer tokens left the escrow insolvent; the balance-delta guard was documented but absent", "Adversarial review", "Fixed"),
        ("High", "A failed broadcast burned the idempotency key forever; topping up the wallet did not help", "Chaos item 7", "Fixed"),
        ("High", "A malformed result was stored and signed for, despite a comment claiming it was validated", "Chaos item 4", "Fixed"),
        ("High", "Session keys had no lifetime bound, though the threat model claimed 24h", "Security pass T1-T17", "Fixed"),
        ("High", "The API sent database ids to the contract, so a worker received nothing while every status code said success", "Live-chain e2e", "Fixed"),
        ("Medium", "Run marked done before its terminal event was recorded; a reader could get a trace missing its ending", "A flaky test, diagnosed", "Fixed"),
        ("Medium", "The indexer retried a failing RPC every 2s forever, a retry storm against a rate limiter", "Chaos item 5", "Fixed"),
        ("Medium", "make coverage and the CI coverage step failed every time: forge coverage disables viaIR, which this project needs", "Deep testing pass", "Fixed"),
        ("Medium", "Nothing tested AgentAccount access control; removing onlyOwner would have failed no test", "Coverage report", "Fixed"),
        ("Medium", "The live-chain verifier reported success while failing, and used a constant specHash that matched an older run", "Full recheck", "Fixed"),
        ("Medium", "The secret scanner fired on ordinary English, training everyone to bypass the hook that guards real keys", "Writing a README", "Fixed"),
        ("Low", "T15 claimed an SSRF guard for a fetch that does not exist anywhere", "Security pass", "Documented"),
        ("Low", "REDIS_URL and API_JWT_SECRET pointed at mechanisms with no implementation", "docs/08 audit", "Removed"),
        ("Critical", "No demo job had ever settled: eight defects between hire and settlement, each hiding the next", "First live runs, Sep 29", "Fixed"),
        ("Critical", "Spending caps were enforced nowhere for EOA agents (all of them); the signer read AgentAccount, failed, and allowed", "Docs audit, Sep 29", "Fixed"),
        ("Critical", "No process ever sent the escrow's permissionless exits; stranded money stayed stranded", "Docs audit, Sep 29", "Fixed: keeper"),
        ("Critical", "A retried hire inserted a phantom job each time, backed by no transaction", "Live e2e, Sep 29", "Fixed"),
        ("Critical", "The indexer linked jobs by spec hash alone, crediting a worker for an old run's payment", "Live e2e, Sep 29", "Fixed"),
        ("High", "Every refund, including a client's cancel, counted as the worker failing", "Docs audit, Sep 29", "Fixed"),
        ("High", "Agents registered through the API or /register could never be hired: nothing set chain_agent_id", "Docs audit, Sep 29", "Fixed"),
        ("High", "The API sent no CORS headers; every browser request was refused", "First browser render, Sep 29", "Fixed"),
        ("High", "fastPathMinScore was read by nothing; unproven workers were paid up front", "Docs audit, Sep 29", "Fixed"),
        ("High", "The signer accepted signing requests from anyone who could reach it", "Docs audit, Sep 29", "Fixed: token"),
        ("High", "The judge's 0-100 score came back on three scales; approved work was disputed", "Live runs, Sep 29", "Fixed"),
        ("Medium", "Recorders sharing a cache file erased each other; a replay lost two of three steps", "Cached replay, Sep 29", "Fixed"),
        ("Medium", "A worker abandoned a job the API had told it to retry", "Mid-job chaos run, Sep 29", "Fixed"),
        ("Medium", "pnpm demo passed with one step of three settled", "Cached replay, Sep 29", "Fixed"),
        ("Medium", "/v1/budget ignored the 24h rollover", "Docs audit, Sep 29", "Fixed"),
        ("Medium", "Deploy ignored ARBITER_ADDRESS and FEE_RECIPIENT; make drift called a script that did not exist", "Docs audit, Sep 29", "Fixed"),
        ("High", "After a reorg a re-mined settlement was credited twice and a dropped one kept forever", "Reorg review, Sep 29", "Fixed: dedupe + halt"),
        ("High", "No agent used AgentAccount, so the on-chain cap claim held for nothing", "Docs audit, Sep 29", "Fixed: orchestrator"),
        ("Medium", "A failed broadcast's nonce claim blocked every later request as in flight", "AgentAccount live run", "Fixed"),
        ("Medium", "An empty gas wallet was reported as an unreachable RPC (503 matched inside tx hex)", "AgentAccount live run", "Fixed"),
        ("Low", "A disputed job has no timeout; only the arbiter can resolve it", "Docs audit, Sep 29", "Documented"),
    ],
    colors={4},
)

# ── 5. Outstanding ────────────────────────────────────────────────────────
ws = sheet(
    wb,
    "Outstanding",
    ["Area", "Item", "Owner", "Priority", "Notes"],
    [16, 44, 10, 12, 54],
)
rows(
    ws,
    [
        ("Setup", "Hosted model key (optional now)", "User", "P2", "Local Ollama works; a Gemini or Groq key would improve judgement quality in the video. One is already in agentx-contracts/.env and was not used without asking."),
        ("Deploy", "Railway (api, signer, indexer) + Vercel", "User", "P1", "Set SIGNER_TOKEN in both API and signer, KEEPER_PRIVATE_KEY in the signer, CORS_ORIGINS in the API."),
        ("Submit", "2-3 minute video", "User", "P1", "Record the cached replay (157 s) and the interface. Claude cannot record video."),
        ("Contracts", "Verify source on the explorer", "User", "P1", "Needs EXPLORER_API_KEY; the config defect is fixed."),
        ("Submit", "Make the three repos public", "User", "P0", "Required by Oct 13."),
        ("Agents", "Give workers AgentAccounts too", "Claude", "P3", "Workers never spend today; only needed if one ever pays another agent."),
        ("Stretch", "x402 facilitator", "Claude", "P3", "First to be cut."),
        ("Post-hack", "Map TaskEscrow onto the ERC-8183 Job interface", "Claude", "P4", "Explicitly out of scope before the deadline."),
    ],
)

# ── 6. About ──────────────────────────────────────────────────────────────
ws = sheet(wb, "About", ["Field", "Value"], [30, 92])
rows(
    ws,
    [
        ("Generated by", "docs/build-status-workbook.py — rebuild rather than edit by hand"),
        ("Source of truth", "agentx-backend/PROGRESS.md"),
        ("As of", "2026-09-29"),
        ("Deadline", "2026-10-13, 11:59 PM ET"),
        ("Track", "4 — Trust, Identity & AI Infrastructure"),
        ("Live network", "Monad testnet, chain 10143"),
        ("TaskEscrow", "0x1b0959dfd32323e5a4749d5444c2e6435349027c"),
        (
            "Formulas",
            "Totals and percentages are formulas so the sheet recalculates when a count changes. They were NOT recalculated when written — that needs LibreOffice, which the build machine lacks — so Excel computes them on first open.",
        ),
    ],
)

wb.save(OUT)
print(f"wrote {OUT}")
