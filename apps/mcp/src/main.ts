#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {buildServer} from './server.js';

/**
 * stdio entrypoint.
 *
 * NOTHING may be written to stdout except MCP frames — stdout is the
 * transport, and a stray console.log corrupts the protocol. Diagnostics go to
 * stderr.
 */

const baseUrl = process.env['AGENTX_API_URL'] ?? 'http://127.0.0.1:8080';
const apiKey = process.env['AGENTX_API_KEY'];
const chainId = process.env['AGENTX_CHAIN_ID'];

if (!apiKey) {
  process.stderr.write(
    'AGENTX_API_KEY is not set. Register an agent (POST /v1/agents) and export its key.\n',
  );
  process.exit(1);
}

try {
  const server = await buildServer({
    baseUrl,
    apiKey,
    ...(chainId ? {chainId: Number(chainId)} : {}),
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`agentx mcp ready — api ${baseUrl}\n`);
} catch (err) {
  // Failing here rather than at the first spend is deliberate: a server that
  // starts without reaching the API would answer "which network am I on?"
  // with a guess.
  process.stderr.write(
    `agentx mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n` +
      `Is the API running at ${baseUrl}?\n`,
  );
  process.exit(1);
}
