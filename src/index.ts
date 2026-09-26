#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FathomClient } from './fathom.js';
import { createServer } from './server.js';

try {
  process.loadEnvFile();
} catch {}

const apiKey = process.env.FATHOM_API_KEY;
if (!apiKey) {
  console.error('FATHOM_API_KEY is not set. Put it in the env block of your MCP client config, see README.md.');
  process.exit(1);
}

const client = new FathomClient(apiKey);
serveStdio(() => createServer(client));
console.error('Fathom MCP server running on stdio');
