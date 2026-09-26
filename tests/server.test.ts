import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server.js';
import { fakeApi, meeting, pagedMeetings } from './helpers.js';

async function connect(route: Parameters<typeof fakeApi>[0]) {
  const { client: fathom, calls } = fakeApi(route);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(fathom).connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, calls };
}

const textOf = (result: { content: unknown }) => (result.content as Array<{ text: string }>)[0].text;

describe('MCP server', () => {
  it('annotates every tool and marks only delete_webhook destructive', async () => {
    const { client } = await connect(pagedMeetings([]));
    const { tools } = await client.listTools();
    for (const tool of tools) assert.ok(tool.title && tool.annotations, tool.name);
    const destructive = tools.filter(t => t.annotations?.destructiveHint).map(t => t.name);
    assert.deepEqual(destructive, ['delete_webhook']);
    const readOnly = tools.filter(t => t.annotations?.readOnlyHint).map(t => t.name).sort();
    assert.equal(readOnly.length, 8);
  });

  it('searches transcripts across the whole scan and returns snippets', async () => {
    const meetings = Array.from({ length: 15 }, (_, i) => meeting(i + 1));
    meetings[12].transcript = [{ speaker: { display_name: 'Jane', matched_calendar_invitee_email: null }, text: 'The renewal price is fine', timestamp: '00:01:00' }];
    const { client, calls } = await connect(pagedMeetings(meetings));
    const result = await client.callTool({ name: 'search_meetings', arguments: { query: 'renewal price', search_in: ['transcript'] } });
    const body = JSON.parse(textOf(result));
    assert.deepEqual(body.meetings.map((m: { recording_id: number }) => m.recording_id), [13]);
    assert.match(body.meetings[0].transcript_snippets[0], /timestamp=60/);
    assert.equal(calls[0].url.searchParams.get('include_transcript'), 'true');
    assert.equal(body.scanned, 15);
  });

  it('filters by attendee without a query', async () => {
    const meetings = [meeting(1), meeting(2, { calendar_invitees: [{ name: 'Jane Roe', email: 'jane@acme.com', email_domain: 'acme.com', is_external: true, matched_speaker_display_name: null }] })];
    const { client } = await connect(pagedMeetings(meetings));
    const body = JSON.parse(textOf(await client.callTool({ name: 'search_meetings', arguments: { attendee: 'acme.com' } })));
    assert.deepEqual(body.meetings.map((m: { recording_id: number }) => m.recording_id), [2]);
  });

  it('rejects a search with neither query nor attendee', async () => {
    const { client } = await connect(pagedMeetings([]));
    const result = await client.callTool({ name: 'search_meetings', arguments: {} });
    assert.equal(result.isError, true);
  });

  it('pages a transcript', async () => {
    const transcript = Array.from({ length: 5 }, (_, i) => ({ speaker: { display_name: 'A', matched_calendar_invitee_email: null }, text: `t${i}`, timestamp: `00:00:0${i}` }));
    const { client } = await connect(() => ({ transcript }));
    const out = textOf(await client.callTool({ name: 'get_meeting_transcript', arguments: { recording_id: 1, start: 1, max_entries: 2 } }));
    assert.equal(out, 'Entries 1-2 of 5. Continue with start=3.\n[00:01] A: t1\n[00:02] A: t2');
  });

  it('refuses a webhook with nothing to include', async () => {
    const { client, calls } = await connect(() => ({}));
    const result = await client.callTool({ name: 'create_webhook', arguments: { destination_url: 'https://x.test', triggered_for: ['my_recordings'] } });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });

  it('turns API failures into tool errors', async () => {
    const { client } = await connect(() => new Response('', { status: 401 }));
    const result = await client.callTool({ name: 'list_teams', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /FATHOM_API_KEY/);
  });

  it('reads a transcript resource', async () => {
    const { client } = await connect(() => ({ transcript: [{ speaker: { display_name: 'A', matched_calendar_invitee_email: null }, text: 'hi', timestamp: '00:00:03' }] }));
    const { contents } = await client.readResource({ uri: 'fathom://recordings/7/transcript' });
    assert.equal((contents[0] as { text: string }).text, '[00:03] A: hi');
  });

  it('stops a search at limit and continues without losing matches', async () => {
    const meetings = Array.from({ length: 25 }, (_, i) => meeting(i + 1, { title: i % 2 ? 'Acme sync' : 'Other' }));
    const { client } = await connect(pagedMeetings(meetings));
    const search = async (cursor?: string) =>
      JSON.parse(textOf(await client.callTool({ name: 'search_meetings', arguments: { query: 'acme', search_in: ['title'], limit: 5, ...(cursor ? { cursor } : {}) } })));
    const first = await search();
    const second = await search(first.next_cursor);
    const third = await search(second.next_cursor);
    const found = [...first.meetings, ...second.meetings, ...third.meetings].map((m: { recording_id: number }) => m.recording_id);
    assert.deepEqual(found, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
    assert.equal(third.next_cursor, null);
  });

  it('rejects whitespace-only search and person input', async () => {
    const { client, calls } = await connect(pagedMeetings([]));
    assert.equal((await client.callTool({ name: 'search_meetings', arguments: { attendee: '  ' } })).isError, true);
    assert.equal((await client.callTool({ name: 'find_person', arguments: { name: '  ' } })).isError, true);
    assert.equal(calls.length, 0);
  });

  it('checks the last meeting of the scan window', async () => {
    const meetings = Array.from({ length: 15 }, (_, i) => meeting(i + 1, { title: i === 9 ? 'Acme' : 'Other' }));
    const { client } = await connect(pagedMeetings(meetings));
    const body = JSON.parse(textOf(await client.callTool({ name: 'search_meetings', arguments: { query: 'acme', search_in: ['title'], max_scan: 10 } })));
    assert.deepEqual(body.meetings.map((m: { recording_id: number }) => m.recording_id), [10]);
  });

  it('keeps matches found before a later page fails', async () => {
    const meetings = Array.from({ length: 20 }, (_, i) => meeting(i + 1, { title: 'Acme' }));
    const pages = pagedMeetings(meetings);
    const { client } = await connect(url => (url.searchParams.get('cursor') ? new Response('', { status: 401 }) : pages(url)));
    const body = JSON.parse(textOf(await client.callTool({ name: 'search_meetings', arguments: { query: 'acme', search_in: ['title'], limit: 50 } })));
    assert.equal(body.meetings.length, 10);
    assert.match(body.error, /FATHOM_API_KEY/);
    assert.ok(body.next_cursor);
  });

  it('answers an empty summary body', async () => {
    const { client } = await connect(() => new Response('', { status: 200 }));
    assert.equal(textOf(await client.callTool({ name: 'get_meeting_summary', arguments: { recording_id: 1 } })), 'This meeting has no summary.');
  });

  it('downloads a transcript once while paging through it', async () => {
    const transcript = Array.from({ length: 4 }, (_, i) => ({ speaker: { display_name: 'A', matched_calendar_invitee_email: null }, text: `t${i}`, timestamp: `00:00:0${i}` }));
    const { client, calls } = await connect(() => ({ transcript }));
    for (const start of [0, 2]) await client.callTool({ name: 'get_meeting_transcript', arguments: { recording_id: 1, start, max_entries: 2 } });
    assert.equal(calls.length, 1);
  });

  it('flags a list cut short by a failing page', async () => {
    const pages = pagedMeetings(Array.from({ length: 20 }, (_, i) => meeting(i + 1)));
    const { client } = await connect(url => (url.searchParams.get('cursor') ? new Response('', { status: 401 }) : pages(url)));
    const body = JSON.parse(textOf(await client.callTool({ name: 'list_meetings', arguments: { limit: 20 } })));
    assert.equal(body.count, 10);
    assert.match(body.error, /Stopped early/);
  });

  it('still finds invitees when the roster fails', async () => {
    const meetings = [meeting(1, { calendar_invitees: [{ name: 'Jane Roe', email: 'jane@acme.com', email_domain: 'acme.com', is_external: true, matched_speaker_display_name: null }] })];
    const pages = pagedMeetings(meetings);
    const { client } = await connect(url => (url.pathname.endsWith('/team_members') ? new Response('', { status: 403 }) : pages(url)));
    const body = JSON.parse(textOf(await client.callTool({ name: 'find_person', arguments: { name: 'jane' } })));
    assert.equal(body.matches[0].email, 'jane@acme.com');
    assert.match(body.roster_error, /403/);
  });

  it('refuses a plain-HTTP webhook URL', async () => {
    const { client, calls } = await connect(() => ({}));
    const result = await client.callTool({ name: 'create_webhook', arguments: { destination_url: 'http://x.test', triggered_for: ['my_recordings'], include_summary: true } });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });

  it('keeps roster matches when the meeting scan fails', async () => {
    const { client } = await connect(url =>
      url.pathname.endsWith('/team_members') ? { items: [{ name: 'Jane Roe', email: 'jane@x.com' }], next_cursor: null } : new Response('', { status: 403 })
    );
    const body = JSON.parse(textOf(await client.callTool({ name: 'find_person', arguments: { name: 'jane' } })));
    assert.equal(body.matches[0].email, 'jane@x.com');
    assert.match(body.error, /403/);
  });

  it('does not cache an empty transcript', async () => {
    const { client, calls } = await connect(() => ({ transcript: [] }));
    for (let i = 0; i < 2; i++) await client.callTool({ name: 'get_meeting_transcript', arguments: { recording_id: 1 } });
    assert.equal(calls.length, 2);
  });

  it('refuses a non-web transcript url', async () => {
    const { client } = await connect(() => ({ transcript: [] }));
    const result = await client.callTool({ name: 'get_meeting_transcript', arguments: { recording_id: 1, url: 'javascript:alert(1)' } });
    assert.equal(result.isError, true);
  });
});
