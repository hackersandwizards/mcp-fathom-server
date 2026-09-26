#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FathomClient } from './fathom.js';
import { defaultIndexPath, MeetingIndex } from './meeting-index.js';
import { createServer } from './server.js';

const apiKey = process.env.FATHOM_API_KEY;
if (!apiKey) {
  console.error('FATHOM_API_KEY is not set. Put it in the env block of your MCP client config, see README.md.');
  process.exit(1);
}

const client = new FathomClient(apiKey);
let index: MeetingIndex | undefined;
if (process.env.FATHOM_INDEX !== 'off') {
  index = new MeetingIndex(client, defaultIndexPath(apiKey));
  await index.load();
  void index.backfill();
}
serveStdio(() => createServer(client, index));
console.error('Fathom MCP server running on stdio');
