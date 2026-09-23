#!/usr/bin/env node
/**
 * Integration check: a real chain, a real settlement, a real database.
 *
 * Unit tests cannot tell you whether the indexer decodes what the contracts
 * actually emit. This drives anvil end to end and asserts on the rows.
 *
 * Prerequisites (the script says so if they are missing):
 *   anvil running, docker compose up -d, migrations applied, `make export` run.
 */

import {createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import postgres from 'postgres';
import {loadConfig, loadAbis} from '@agentx/config';
import {createDb, closeDb} from '@agentx/db';
import {Indexer} from '../apps/indexer/dist/indexer.js';

const RPC = 'http://127.0.0.1:8545';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
// anvil account 0 — a published test key, worthless by design.
const DEPLOYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  process.exitCode = 1;
};

const config = loadConfig();
const abis = loadAbis();
const chain = config.chain(31337);

const pub = createPublicClient({chain: foundry, transport: http(RPC)});
const wallet = createWalletClient({account: DEPLOYER, chain: foundry, transport: http(RPC)});

const addr = (n) => {
  const a = chain.contracts[n] ?? chain.erc8004[n];
  if (!a) throw new Error(`no address for ${n} in deployments/31337.json`);
  return a;
};

const identity = chain.erc8004['identityRegistry'];
const reputation = chain.erc8004['reputationRegistry'];
const token = addr('PaymentToken');
const vault = addr('StakeVault');
const escrow = addr('TaskEscrow');

console.log('\nAGENTX indexer verification');
console.log(`  chain    ${chain.name} (${chain.chainId})`);
console.log(`  escrow   ${escrow}\n`);

const write = async (address, abi, functionName, args) => {
  const hash = await wallet.writeContract({address, abi, functionName, args});
  return pub.waitForTransactionReceipt({hash});
};

// ── 1. two agents, bonded ────────────────────────────────────────────────
const idAbi = abis['MockIdentityRegistry'];
const vaultAbi = abis['StakeVault'];
const escrowAbi = abis['TaskEscrow'];
const erc20 = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

await write(identity, idAbi, 'register', ['ipfs://client', DEPLOYER.address]);
await write(identity, idAbi, 'register', ['ipfs://worker', DEPLOYER.address]);
const clientAgentId = 1n;
const workerAgentId = 2n;
ok(`registered agents ${clientAgentId} and ${workerAgentId} in ERC-8004`);

await write(token, erc20, 'mint', [DEPLOYER.address, 1_000_000_000n]);
await write(token, erc20, 'approve', [vault, 1_000_000_000n]);
await write(vault, vaultAbi, 'deposit', [workerAgentId, 10_000_000n]);

const hireable = await pub.readContract({address: vault, abi: vaultAbi, functionName: 'isHireable', args: [workerAgentId]});
hireable ? ok('worker is bonded and hireable') : fail('worker should be hireable');

// ── 2. settle a job on-chain ─────────────────────────────────────────────
await write(token, erc20, 'approve', [escrow, 1_000_000_000n]);
const specHash = keccak256(toHex('verify-indexer-spec'));
const before = await pub.readContract({address: token, abi: erc20, functionName: 'balanceOf', args: [DEPLOYER.address]});

// The escrow's job counter persists across runs of this script, so the id
// must be read, never assumed. Assuming it silently indexes nothing.
const expectedJobId = await pub.readContract({
  address: escrow,
  abi: escrowAbi,
  functionName: 'nextJobId',
});

const receipt = await write(escrow, escrowAbi, 'directPay', [clientAgentId, workerAgentId, 20_000n, specHash]);
ok(`directPay settled as job ${expectedJobId} in block ${receipt.blockNumber}`);

// The indexer deliberately trails the head by `confirmations`, so the block
// holding the settlement is not yet safe to index. Mine past it rather than
// racing the chain — a flaky test is worse than no test.
await fetch(RPC, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'anvil_mine', params: ['0x5']}),
});
ok(`mined past the settlement (trailing ${chain.confirmations} confirmation(s))`);

// ── 3. the API row the indexer will project onto ─────────────────────────
const sql = postgres(DB_URL, {max: 1, onnotice: () => {}});
await sql`TRUNCATE agents, jobs, job_events, agent_stats, payments, agent_capabilities RESTART IDENTITY CASCADE`;
await sql`DELETE FROM indexer_cursor`; // replay from the deployment block, so the run is self-contained

const [clientRow] = await sql`
  INSERT INTO agents (chain_id, chain_agent_id, owner_address, wallet_address, name, price_per_task)
  VALUES (31337, ${clientAgentId}, ${DEPLOYER.address}, ${DEPLOYER.address}, 'ClientBot', 20000)
  RETURNING id`;
const [workerRow] = await sql`
  INSERT INTO agents (chain_id, chain_agent_id, owner_address, wallet_address, name, price_per_task)
  VALUES (31337, ${workerAgentId}, ${DEPLOYER.address}, ${'0x000000000000000000000000000000000000dEaD'}, 'WorkerBot', 20000)
  RETURNING id`;

await sql`
  INSERT INTO jobs (chain_id, chain_job_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash)
  VALUES (31337, ${expectedJobId}, ${clientRow.id}, ${workerRow.id}, 'direct', 20000, '{}', ${specHash})`;

// ── 4. run the indexer ───────────────────────────────────────────────────
const db = createDb(DB_URL);
const indexer = new Indexer({db, chain, abis});
await indexer.tick();
ok('indexer tick completed');

// ── 5. assert on the rows ────────────────────────────────────────────────
const events = await sql`SELECT kind, tx_hash, log_index FROM job_events ORDER BY id`;
events.length > 0 ? ok(`job_events written: ${events.map((e) => e.kind).join(', ')}`) : fail('no job_events written');

const [job] = await sql`SELECT state FROM jobs WHERE chain_job_id = ${expectedJobId}`;
job?.state === 'settled' ? ok(`job projected to state "${job.state}"`) : fail(`job state is "${job?.state}", expected settled`);

const [stats] = await sql`SELECT completed, failed, score FROM agent_stats WHERE agent_id = ${workerRow.id}`;
if (stats) {
  ok(`reputation: completed=${stats.completed} failed=${stats.failed} score=${stats.score}`);
  // One completion must NOT read as a perfect score — that is the whole
  // point of the volume damping.
  Number(stats.score) < 100
    ? ok(`one job does not produce a perfect score (${stats.score})`)
    : fail(`score ${stats.score} — volume damping is not working`);
} else {
  fail('no agent_stats row written');
}

// ── 6. re-running must change nothing ────────────────────────────────────
const cursorBefore = await sql`SELECT last_block, last_block_hash FROM indexer_cursor`;
await indexer.tick();
await indexer.tick();
const eventsAfter = await sql`SELECT count(*)::int AS n FROM job_events`;

eventsAfter[0].n === events.length
  ? ok(`replay is a no-op (${events.length} events before and after two more ticks)`)
  : fail(`replay duplicated events: ${events.length} -> ${eventsAfter[0].n}`);

cursorBefore.length === 1 ? ok(`cursor at block ${cursorBefore[0].last_block}`) : fail('no cursor row');

// ── 7. simulate a reorg: corrupt the stored hash ─────────────────────────
await sql`UPDATE indexer_cursor SET last_block_hash = ${'0x' + 'de'.repeat(32)}`;
await indexer.tick();
const afterReorg = await sql`SELECT count(*)::int AS n FROM job_events`;
afterReorg[0].n === events.length
  ? ok('reorg rewind replayed without duplicating anything')
  : fail(`reorg replay duplicated events: ${events.length} -> ${afterReorg[0].n}`);

await sql.end();
await closeDb(db);
console.log(process.exitCode ? '\nFAILED\n' : '\nAll indexer checks passed.\n');
