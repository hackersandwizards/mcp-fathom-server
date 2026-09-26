import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { MeetingIndex, peopleOf } from '../src/meeting-index.js';
import { createServer } from '../src/server.js';
import { fakeApi, meeting, pagedMeetings } from './helpers.js';

const speaker = (name: string, text = 'hi') => ({ speaker: { display_name: name, matched_calendar_invitee_email: null }, text, timestamp: '00:00:01' });

function history() {
  const meetings = Array.from({ length: 25 }, (_, i) => meeting(i + 1, { created_at: `2026-01-${String(30 - i).padStart(2, '0')}T10:00:00Z`, transcript: [] }));
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
    const page = after ? { items: live.filter(m => m.created_at > after), next_cursor: null } : pages(url);
    // Like Fathom, a listing carries transcripts only when asked for them.
    if (url.searchParams.get('include_transcript') === 'true') return page;
    return { ...page, items: page.items.map(({ transcript: _, ...m }) => m) };
  });
  const path = join(await mkdtemp(join(tmpdir(), 'fathom-index-')), 'index.json');
  const index = new MeetingIndex(api.client, path, async () => {});
  await index.lock();
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
    assert.equal(calls.length, before, 'a hit needs no request');
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
    await first.lock();
    await first.backfill();
    assert.equal(first.size, 10);
    failing = false;
    const second = new MeetingIndex(client, path, async () => {});
    await second.load();
    await second.lock();
    const before = calls.length;
    await second.backfill();
    assert.equal(second.size, 25);
    assert.equal(calls.length - before, 2, 'continues from page 2, not from the start');
  });

  it('merges an invitee who spoke into one person', () => {
    const m = meeting(1, {
      calendar_invitees: [{ name: 'Alice Smith', email: 'alice@x.com', email_domain: 'x.com', is_external: true, matched_speaker_display_name: 'Alice S.' }],
      transcript: [speaker('Alice S.'), speaker('Bob')]
    });
    assert.deepEqual(peopleOf(m), [
      { name: 'Alice Smith', email: 'alice@x.com', external: true, invited: true, spoke: true, aliases: ['Alice S.'] },
      { name: 'Bob', email: null, external: null, invited: false, spoke: true }
    ]);
  });

  it('keeps the watermark when a refresh fails halfway, so no meeting is skipped', async () => {
    const meetings = history();
    const pages = pagedMeetings(meetings);
    const newer = [meeting(101, { created_at: '2026-02-02T10:00:00Z' }), meeting(100, { created_at: '2026-02-01T10:00:00Z' })];
    let failSecondPage = false;
    const { client } = fakeApi(url => {
      if (!url.searchParams.get('created_after')) return pages(url);
      if (!url.searchParams.get('cursor')) return { items: [newer[0]], next_cursor: 'p2' };
      return failSecondPage ? new Response('', { status: 401 }) : { items: [newer[1]], next_cursor: null };
    });
    const path = join(await mkdtemp(join(tmpdir(), 'fathom-index-')), 'index.json');
    const index = new MeetingIndex(client, path, async () => {});
    await index.lock();
    await index.backfill();
    failSecondPage = true;
    assert.match((await index.freshen(Infinity))!, /missing/);
    failSecondPage = false;
    assert.equal(await index.freshen(Infinity), undefined);
    assert.equal(index.findByLink('/calls/100')?.recording_id, 100);
  });

  it('restarts a backfill whose saved cursor Fathom rejects', async () => {
    const meetings = history();
    const path = join(await mkdtemp(join(tmpdir(), 'fathom-index-')), 'index.json');
    const pages = pagedMeetings(meetings);
    const { client } = fakeApi(url => (url.searchParams.get('cursor')?.includes('stale') ? new Response('{"message":"bad cursor"}', { status: 400 }) : pages(url)));
    const index = new MeetingIndex(client, path, async () => {});
    await index.lock();
    (index as unknown as { state: { backfill_cursor: string } }).state.backfill_cursor = '0..stale';
    await index.backfill();
    assert.equal(index.size, 25);
  });

  it('lets only the lock holder write', async () => {
    const { path } = await built();
    const other = new MeetingIndex(fakeApi(() => ({})).client, path);
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, String(process.ppid));
    assert.equal(await other.lock(), false);
  });

  it('falls back to scanning meetings older than a partial index', async () => {
    const meetings = history();
    const pages = pagedMeetings(meetings);
    const api = fakeApi(url => {
      if (url.searchParams.get('created_after')) return { items: [], next_cursor: null };
      const before = url.searchParams.get('created_before');
      return before ? { items: meetings.filter(m => m.created_at < before), next_cursor: null } : pages(url);
    });
    const path = join(await mkdtemp(join(tmpdir(), 'fathom-index-')), 'index.json');
    const index = new MeetingIndex(api.client, path, async () => {});
    await index.lock();
    index.stop();
    (index as unknown as { add: (m: unknown[]) => void }).add(meetings.slice(0, 10));
    (index as unknown as { state: { newest_created_at: string } }).state.newest_created_at = meetings[0].created_at;
    const mcp = await connect(api.client, index);
    assert.equal(body(await mcp.callTool({ name: 'find_meeting_by_link', arguments: { link: '/share/s20' } })).recording_id, 20);
    assert.ok(api.calls.some(c => c.url.searchParams.get('created_before') === meetings[9].created_at));
  });

  it('re-walks without transcripts, adding shared meetings and dropping deleted ones', async () => {
    const { index, live, calls, client } = await built();
    live.splice(3, 1);
    live.splice(10, 0, meeting(200, { created_at: '2026-01-19T12:00:00Z', transcript: [speaker('Late Speaker')] }));
    (index as unknown as { startWalk: () => void }).startWalk();
    assert.equal(index.coverage().complete, true, 'the old index stays usable');
    const before = calls.length;
    await index.backfill();
    const walked = calls.slice(before);
    assert.equal(walked.filter(c => c.url.searchParams.get('include_transcript') === 'true').length, 1, 'only the page with the new meeting is re-read with transcripts');
    assert.equal(index.size, 25);
    assert.equal(index.findByLink('/calls/4'), undefined);
    const mcp = await connect(client, index);
    assert.equal(body(await mcp.callTool({ name: 'find_person', arguments: { name: 'rita' } })).matches[0].spoke_in, 1, 'speakers kept');
    assert.equal(body(await mcp.callTool({ name: 'find_person', arguments: { name: 'late' } })).matches[0].latest_meeting.recording_id, 200);
  });

  it('re-reads a day of meetings after a link lookup missed', async () => {
    const { client, index, calls } = await built();
    const mcp = await connect(client, index);
    assert.equal((await mcp.callTool({ name: 'find_meeting_by_link', arguments: { link: '999' } })).isError, true);
    assert.ok(calls.some(c => c.url.searchParams.get('created_after') === '2026-01-29T10:00:00.000Z'));
  });

  it('stops the loop on a 401 after the first page of a sync', { timeout: 2000 }, async () => {
    const meetings = history();
    const pages = pagedMeetings(meetings);
    const { client } = fakeApi(url => {
      if (!url.searchParams.get('created_after')) return pages(url);
      return url.searchParams.get('cursor') ? new Response('', { status: 401 }) : { items: [meeting(101, { created_at: '2026-02-02T10:00:00Z' })], next_cursor: 'p2' };
    });
    const path = join(await mkdtemp(join(tmpdir(), 'fathom-index-')), 'index.json');
    const index = new MeetingIndex(client, path, async () => {});
    await index.run();
    assert.equal(index.coverage().complete, true);
    await assert.rejects(stat(`${path}.lock`), 'the stopped writer gives the lock up');
  });

  it('tops up a partial index with a scan of older meetings only', async () => {
    const meetings = history();
    const api = fakeApi(url => {
      if (url.pathname.endsWith('/team_members') || url.searchParams.get('created_after')) return { items: [], next_cursor: null };
      const before = url.searchParams.get('created_before');
      return { items: meetings.filter(m => !before || m.created_at < before).slice(0, 10), next_cursor: null };
    });
    const index = new MeetingIndex(api.client, join(await mkdtemp(join(tmpdir(), 'fathom-index-')), 'index.json'), async () => {});
    (index as unknown as { add: (m: unknown[]) => void }).add(meetings.slice(0, 10));
    (index as unknown as { state: { newest_created_at: string } }).state.newest_created_at = meetings[0].created_at;
    const mcp = await connect(api.client, index);
    const result = body(await mcp.callTool({ name: 'find_person', arguments: { name: 'rita', max_scan: 20 } }));
    assert.equal(result.scanned_meetings, 10);
    const scan = api.calls.find(c => c.url.searchParams.get('created_before'))!;
    assert.equal(scan.url.searchParams.get('created_before'), meetings[9].created_at);
    assert.equal(scan.url.searchParams.get('include_transcript'), 'true');
  });

  it('finds an invitee by the speaker name Fathom matched', async () => {
    const m = meeting(1, { calendar_invitees: [{ name: 'Robert Smith', email: 'rob@x.com', email_domain: 'x.com', is_external: false, matched_speaker_display_name: 'Bob' }] });
    const { index, client } = await built([m]);
    const mcp = await connect(client, index);
    assert.equal(body(await mcp.callTool({ name: 'find_person', arguments: { name: 'bob', max_scan: 10 } })).matches[0].email, 'rob@x.com');
  });

  it('prefers a speaker name over an email shown as the invitee name', () => {
    const m = meeting(1, {
      calendar_invitees: [{ name: 'nb@x.com', email: 'nb@x.com', email_domain: 'x.com', is_external: true, matched_speaker_display_name: 'Niklas B' }],
      transcript: [speaker('Niklas B')]
    });
    assert.deepEqual(peopleOf(m)[0], { name: 'Niklas B', email: 'nb@x.com', external: true, invited: true, spoke: true, aliases: ['nb@x.com'] });
  });

  it('takes over a lock its writer stopped touching, even if the pid runs', async () => {
    const { path } = await built();
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, String(process.ppid));
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(lockPath, old, old);
    assert.equal(await new MeetingIndex(fakeApi(() => ({})).client, path).lock(), true);
  });

  it('picks up the first meeting of an empty history', async () => {
    const { index, live } = await built([]);
    live.push(meeting(1));
    assert.equal(await index.freshen(Infinity, 0), undefined);
    assert.equal(index.size, 1);
  });

  it('lets a reader add new meetings in memory without writing the file', async () => {
    const { path, live, client } = await built();
    const reader = new MeetingIndex(client, path, async () => {});
    const before = (await stat(path)).mtimeMs;
    live.unshift(meeting(100, { created_at: '2026-02-01T10:00:00Z' }));
    const mcp = await connect(client, reader);
    const hit = body(await mcp.callTool({ name: 'find_meeting_by_link', arguments: { link: '100' } }));
    assert.equal(hit.recording_id, 100);
    assert.deepEqual(hit.attendees, []);
    assert.equal((await stat(path)).mtimeMs, before);
  });

  it('syncs a tool call from the newest meeting without overlap, and at most once a minute', async () => {
    const { index, calls } = await built();
    await index.freshen(Infinity);
    await index.freshen(Infinity);
    const syncs = calls.filter(c => c.url.searchParams.get('created_after'));
    assert.equal(syncs.length, 1);
    assert.equal(syncs[0].url.searchParams.get('created_after'), '2026-01-30T10:00:00.000Z');
  });

  it('stops the loop when the cache directory cannot be created', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fathom-index-'));
    await writeFile(join(dir, 'file'), '');
    const index = new MeetingIndex(fakeApi(() => ({})).client, join(dir, 'file', 'index.json'), async () => {});
    await index.run();
    assert.equal(index.size, 0);
  });

  it('scans with transcripts when the index cannot answer, so speakers are found', async () => {
    const api = fakeApi(() => ({ items: [], next_cursor: null }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(api.client).connect(b);
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    await mcp.connect(a);
    await mcp.callTool({ name: 'find_person', arguments: { name: 'rita' } });
    assert.ok(api.calls.some(c => c.url.pathname.endsWith('/meetings') && c.url.searchParams.get('include_transcript') === 'true'));
  });

  it('finishes a re-walk when a new meeting has no readable transcript, and retries it next walk', async () => {
    const { index, live, calls } = await built();
    live.splice(5, 0, meeting(300, { created_at: '2026-01-24T12:00:00Z', transcript: null as never }));
    (index as unknown as { startWalk: () => void }).startWalk();
    await index.backfill();
    assert.equal(index.findByLink('/calls/300')?.recording_id, 300);
    assert.equal(index.size, 26);
    const before = calls.length;
    (index as unknown as { startWalk: () => void }).startWalk();
    await index.backfill();
    assert.equal(calls.slice(before).filter(c => c.url.searchParams.get('include_transcript') === 'true').length, 1, 'only the page with the missing transcript is re-read');
  });

  it('does not rewrite the file when a sync finds only known meetings', async () => {
    const { index, path } = await built();
    const before = (await stat(path)).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await index.freshen(Infinity), undefined);
    assert.equal((await stat(path)).mtimeMs, before);
  });

  it('merges a speaker without an email through an alias of an invitee', async () => {
    const invited = meeting(1, {
      created_at: '2026-01-02T10:00:00Z',
      calendar_invitees: [{ name: 'bob@x.com', email: 'bob@x.com', email_domain: 'x.com', is_external: true, matched_speaker_display_name: 'Bob Smith' }]
    });
    const spoke = meeting(2, { created_at: '2026-01-03T10:00:00Z', transcript: [speaker('Bob Smith')] });
    const { index, client } = await built([spoke, invited]);
    const mcp = await connect(client, index);
    const { matches } = body(await mcp.callTool({ name: 'find_person', arguments: { name: 'bob', max_scan: 10 } }));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].meetings, 2);
  });

  it('gives up waiting for a busy index at the time limit', async () => {
    const { index } = await built();
    void (index as unknown as { serial: (work: () => Promise<unknown>) => Promise<unknown> }).serial(() => new Promise(resolve => setTimeout(resolve, 1000)));
    const started = Date.now();
    assert.match((await index.freshen(Date.now() + 50, true))!, /busy/);
    assert.ok(Date.now() - started < 500);
  });

  it('counts a speaker without an email under the invitee with the same name', async () => {
    const invited = meeting(1, {
      created_at: '2026-01-02T10:00:00Z',
      calendar_invitees: [{ name: 'Anna Schmidt', email: 'anna@x.com', email_domain: 'x.com', is_external: true, matched_speaker_display_name: null }]
    });
    const spoke = meeting(2, { created_at: '2026-01-03T10:00:00Z', transcript: [speaker('Anna Schmidt')] });
    const { index, client } = await built([spoke, invited]);
    const mcp = await connect(client, index);
    const { matches } = body(await mcp.callTool({ name: 'find_person', arguments: { name: 'anna', max_scan: 10 } }));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].email, 'anna@x.com');
    assert.equal(matches[0].meetings, 2);
    assert.equal(matches[0].latest_meeting.recording_id, 2);
  });

  it('keeps the index when a resumed walk ends early, and walks again from the top', async () => {
    // The fake serves page p9 as an empty last page, as an expired cursor might.
    const { path, client } = await built();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...saved, walking: true, walk: 1, backfill_cursor: '0..p9' }));
    const resumed = new MeetingIndex(client, path, async () => {});
    await resumed.load();
    await resumed.lock();
    await resumed.backfill();
    assert.equal(resumed.size, 25);
  });

  it('counts a meeting once when two of its entries are the same person', async () => {
    const m = meeting(1, {
      transcript: [speaker('Ben')],
      calendar_invitees: [{ name: 'Benedikt S', email: 'b@x.com', email_domain: 'x.com', is_external: false, matched_speaker_display_name: null }]
    });
    const linked = meeting(2, {
      created_at: '2025-12-01T10:00:00Z',
      calendar_invitees: [{ name: 'Benedikt S', email: 'b@x.com', email_domain: 'x.com', is_external: false, matched_speaker_display_name: 'Ben' }]
    });
    const { index, client } = await built([m, linked]);
    const mcp = await connect(client, index);
    const { matches } = body(await mcp.callTool({ name: 'find_person', arguments: { name: 'ben', max_scan: 10 } }));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].meetings, 2);
    assert.equal(matches[0].spoke_in, 1);
  });

  it('re-reads the last day without transcripts, and saves speakers it fills in', async () => {
    const { index, live, calls, path } = await built();
    const forward = () => (index as unknown as { forward: (d: number, o: number, b: boolean) => Promise<void> }).forward(Infinity, 24 * 3_600_000, true);
    let before = calls.length;
    await forward();
    assert.deepEqual(calls.slice(before).map(c => c.url.searchParams.get('include_transcript')), ['false'], 'nothing missing, one cheap listing');
    (index as unknown as { state: { meetings: Record<string, { speakers_missing?: true }> } }).state.meetings[1].speakers_missing = true;
    live[0].transcript = [speaker('Zed Late')];
    before = calls.length;
    await forward();
    assert.deepEqual(calls.slice(before).map(c => c.url.searchParams.get('include_transcript')), ['false', 'true']);
    assert.match(await readFile(path, 'utf8'), /Zed Late/);
  });

  it('finds a meeting shared days after it was recorded, which the complete index lacks', async () => {
    const { index, client, live } = await built();
    // Created before the newest indexed meeting minus the day of overlap, so no sync lists it.
    live.splice(3, 0, meeting(400, { created_at: '2026-01-27T12:00:00Z', transcript: [] }));
    const mcp = await connect(client, index);
    assert.equal(body(await mcp.callTool({ name: 'find_meeting_by_link', arguments: { link: '400' } })).recording_id, 400);
  });
});
