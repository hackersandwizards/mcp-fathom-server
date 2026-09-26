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
  // The loop logs and retries its own errors, such as an unwritable cache directory; tools fall back to scans.
  void index.run();
}
// Exit through process.exit on these signals too, so the index lock is released.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(0));
serveStdio(() => createServer(client, index));
console.error('Fathom MCP server running on stdio');
