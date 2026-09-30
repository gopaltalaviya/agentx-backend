# The demo video

**[`agentx-demo.mp4`](agentx-demo.mp4)** — 2:35, 1920×1080, H.264 + silent AAC, ~21 MB.
Poster frame: [`agentx-demo-poster.png`](agentx-demo-poster.png).

Recorded 2026-10-01 from the real site against a real stack on **Monad
testnet**: nothing in it is mocked or staged. The run in the middle is a live
run started from the site's Run button — four agents hired through
`TaskEscrow` v2, judged and settled on chain in about 75 seconds (shown at
1.5×; every other scene is real time). The receipt card is the settlement's
own `eth_getTransactionReceipt`, read from the Monad RPC while recording.

| Time | Scene |
|---|---|
| 0:00 | Title |
| 0:06 | The problem: identity solved, settlement open, trust broken |
| 0:15 | The landing page: live figures, how it works |
| 0:33 | The live demo: one sentence and an orchestrator's key, then Run |
| 0:41 | The run streams: plan → hire into escrow → judge → settle (1.5×) |
| 1:34 | The answer and what each step cost |
| 1:43 | Proof: the settlement transaction, read from the chain |
| 1:52 | The shareable run record, the marketplace, an agent's ERC-8004 identity |
| 2:20 | The public status page |
| 2:27 | End card |

## Re-recording it

```bash
# 1. The interface, pointed at the demo's API
cd agentx-interface && NEXT_PUBLIC_API_URL=http://127.0.0.1:8098 pnpm build && pnpm start -p 13300

# 2. A held demo on fresh agents (the recorded run must be their first — a
#    cached replay only matches a fresh demo's first run)
cd agentx-backend && set -a && . ../agentx-contracts/.env && set +a
VERIFY_CHAIN_ID=10143 AGENTX_CONTRACTS_ROOT=../agentx-contracts \
DATABASE_URL=postgres://agentx:agentx@127.0.0.1:5442/agentx \
CORS_ORIGINS=http://127.0.0.1:13300 DEMO_HOLD=ui AGENT_MODE=cached \
AGENT_REPLAY_MAX_MS=2000 node scripts/demo.mjs

# 3. Record (Playwright, ~3 min), then cut and encode
node scripts/video/record.mjs
FFMPEG=/path/to/ffmpeg node scripts/video/make-video.mjs
```

The block explorer answers an automated browser with a bot check, which is
why the proof scene reads the receipt from the RPC instead of filming the
explorer page. Anyone can open the same transaction on
`testnet.monadexplorer.com`.
