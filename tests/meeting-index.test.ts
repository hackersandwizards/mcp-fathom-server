import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { MeetingIndex } from '../src/meeting-index.js';
import { createServer } from '../src/server.js';
import { fakeApi, meeting, pagedMeetings } from './helpers.js';

const speaker = (name: string, text = 'hi') => ({ speaker: { display_name: name, matched_calendar_invitee_email: null }, text, timestamp: '00:00:01' });

function history() {
  const meetings = Array.from({ length: 25 }, (_, i) => meeting(i + 1, { created_at: `2026-01-${String(30 - i).padStart(2, '0')}T10:00:00Z` }));
  // An old meeting where Rita only spoke, without being on the invite.
  meetings[24].transcript = [speaker('Rita Speaker')];
  return meetings;
}

async function built(meetings = history()) {
  const live = meetings.slice();
  const pages = pagedMeetings(live);
  const api = fakeApi(url => {
    if (url.pathname.endsWith('/team_members')) return { items: [], next_cursor: null };
    const after = url.searchParams.get('created_after');
    return after ? { items: live.filter(m => m.created_at > after), next_cursor: null } : pages(url);
  });
  const path = join(await mkdtemp(join(tmpdir(), 'fathom-index-')), 'index.json');
  const index = new MeetingIndex(api.client, path, async () => {});
  await index.backfill();
  return { index, path, live, calls: api.calls, client: api.client };
}

async function connect(client: Parameters<typeof createServer>[0], index: MeetingIndex) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(client, index).connect(b);
  const mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(a);
  return mcp;
}

const body = (result: { content: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

describe('MeetingIndex', () => {
  it('backfills the whole history with transcripts and saves it privately', async () => {
    const { index, path, calls } = await built();
    assert.deepEqual(index.coverage(), { indexed_meetings: 25, complete: true, oldest_indexed: '2026-01-06T10:00:00Z' });
    assert.equal(calls[0].url.searchParams.get('include_transcript'), 'true');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const reloaded = new MeetingIndex(fakeApi(() => ({})).client, path);
    await reloaded.load();
    assert.equal(reloaded.size, 25);
    assert.ok(JSON.parse(await readFile(path, 'utf8')).complete);
  });

  it('finds a person who only spoke, in the oldest meeting', async () => {
    const { index, client } = await built();
    const mcp = await connect(client, index);
    const result = body(await mcp.callTool({ name: 'find_person', arguments: { name: 'rita' } }));
    assert.equal(result.matches[0].name, 'Rita Speaker');
    assert.equal(result.matches[0].spoke_in, 1);
    assert.equal(result.matches[0].latest_meeting.url, 'https://fathom.video/share/s25');
    assert.equal(result.index.complete, true);
  });

  it('resolves an old link from the index and picks up new meetings', async () => {
    const { index, client, live, calls } = await built();
    const mcp = await connect(client, index);
    const before = calls.length;
    assert.equal(body(await mcp.callTool({ name: 'find_meeting_by_link', arguments: { link: 'https://fathom.video/calls/25' } })).recording_id, 25);
    assert.equal(calls.length, before + 1, 'one refresh request, no scan');
    live.unshift(meeting(100, { created_at: '2026-02-01T10:00:00Z' }));
    assert.equal(body(await mcp.callTool({ name: 'find_meeting_by_link', arguments: { link: '100' } })).recording_id, 100);
    const miss = await mcp.callTool({ name: 'find_meeting_by_link', arguments: { link: '999' } });
    assert.equal(miss.isError, true);
  });

  it('resumes an interrupted backfill where it stopped', async () => {
    const meetings = history();
    const path = join(await mkdtemp(join(tmpdir(), 'fathom-index-')), 'index.json');
    let failing = true;
    const pages = pagedMeetings(meetings);
    const { client, calls } = fakeApi(url => (failing && url.searchParams.get('cursor') ? new Response('', { status: 401 }) : pages(url)));
    const first = new MeetingIndex(client, path, async () => {});
    await first.backfill();
    assert.equal(first.size, 10);
    failing = false;
    const second = new MeetingIndex(client, path, async () => {});
    await second.load();
    const before = calls.length;
    await second.backfill();
    assert.equal(second.size, 25);
    assert.equal(calls.length - before, 2, 'continues from page 2, not from the start');
  });
});
