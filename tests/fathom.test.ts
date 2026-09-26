import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fakeApi, meeting, pagedMeetings } from './helpers.js';

const meetings = Array.from({ length: 25 }, (_, i) => meeting(i + 1));
const ids = (items: { recording_id: number }[]) => items.map(m => m.recording_id);

describe('FathomClient pagination', () => {
  it('continues mid-page without skipping meetings', async () => {
    const { client } = fakeApi(pagedMeetings(meetings));
    const first = await client.listMeetings({}, 7);
    assert.deepEqual(ids(first.items), [1, 2, 3, 4, 5, 6, 7]);
    const second = await client.listMeetings({}, 7, first.next_cursor!);
    assert.deepEqual(ids(second.items), [8, 9, 10, 11, 12, 13, 14]);
    const rest = await client.listMeetings({}, 100, second.next_cursor!);
    assert.deepEqual(ids(rest.items), Array.from({ length: 11 }, (_, i) => i + 15));
    assert.equal(rest.next_cursor, null);
  });

  it('resumes after the last returned meeting when new ones arrive', async () => {
    const live = meetings.slice();
    const { client } = fakeApi(url => pagedMeetings(live)(url));
    const first = await client.listMeetings({}, 5);
    live.unshift(meeting(99));
    const second = await client.listMeetings({}, 3, first.next_cursor!);
    assert.deepEqual(ids(second.items), [6, 7, 8]);
  });

  it('finds the resume anchor after new meetings push it to the next page', async () => {
    const live = meetings.slice();
    const { client } = fakeApi(url => pagedMeetings(live)(url));
    const first = await client.listMeetings({}, 5);
    live.unshift(...[91, 92, 93, 94, 95, 96].map(id => meeting(id)));
    const second = await client.listMeetings({}, 3, first.next_cursor!);
    assert.deepEqual(ids(second.items), [6, 7, 8]);
  });

  it('returns a cursor when the limit ends exactly on a page boundary', async () => {
    const { client, calls } = fakeApi(pagedMeetings(meetings));
    const first = await client.listMeetings({}, 10);
    assert.equal(calls.length, 1);
    const second = await client.listMeetings({}, 10, first.next_cursor!);
    assert.deepEqual(ids(second.items), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it('rejects a cursor it did not issue', async () => {
    const { client } = fakeApi(pagedMeetings(meetings));
    await assert.rejects(client.listMeetings({}, 5, 'garbage'), /Invalid cursor/);
  });

  it('sends array filters as repeated key[] parameters', async () => {
    const { client, calls } = fakeApi(pagedMeetings([]));
    await client.listMeetings({ teams: ['Sales', 'Eng'], include_summary: true, meeting_type: undefined }, 5);
    assert.deepEqual(calls[0].url.searchParams.getAll('teams[]'), ['Sales', 'Eng']);
    assert.equal(calls[0].url.searchParams.get('include_summary'), 'true');
    assert.equal(calls[0].url.searchParams.has('meeting_type'), false);
    assert.equal((calls[0].init.headers as Record<string, string>)['X-Api-Key'], 'test-key');
  });

  it('follows every page of team members', async () => {
    const { client } = fakeApi(url =>
      url.searchParams.get('cursor')
        ? { items: [{ name: 'B', email: 'b@x.com' }], next_cursor: null }
        : { items: [{ name: 'A', email: 'a@x.com' }], next_cursor: 'next' }
    );
    assert.deepEqual((await client.listTeamMembers()).map(m => m.name), ['A', 'B']);
  });
});

describe('FathomClient errors and retries', () => {
  it('retries a 429 and honours Retry-After', async () => {
    const waits: number[] = [];
    const { client, calls } = fakeApi((_url, _init, n) =>
      n === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '2' } }) : { items: [], next_cursor: null }
    );
    (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async ms => void waits.push(ms);
    await client.listMeetings({}, 5);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [2000]);
  });

  it('gives up after repeated 429s with an actionable message', async () => {
    const { client, calls } = fakeApi(() => new Response('', { status: 429 }));
    await assert.rejects(client.listMeetings({}, 5), /rate limit still exceeded/);
    assert.equal(calls.length, 5);
  });

  it('does not retry a failed POST', async () => {
    const { client, calls } = fakeApi(() => new Response('{"message":"boom"}', { status: 500 }));
    const body = { destination_url: 'https://x.test', triggered_for: ['my_recordings' as const], include_summary: true, include_transcript: false, include_action_items: false, include_crm_matches: false };
    await assert.rejects(client.createWebhook(body), /500.*boom/);
    assert.equal(calls.length, 1);
  });

  it('explains a 404 on a recording', async () => {
    const { client } = fakeApi(() => new Response('', { status: 404 }));
    await assert.rejects(client.getSummary(42), /calls\/<id> link is a different ID/);
  });

  it('posts the webhook body the API expects', async () => {
    const { client, calls } = fakeApi(() => ({ id: 'w1', secret: 'whsec_x' }));
    const body = { destination_url: 'https://x.test/hook', triggered_for: ['my_recordings' as const], include_summary: true, include_transcript: false, include_action_items: false, include_crm_matches: false };
    await client.createWebhook(body);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body as string), body);
  });

  it('handles an empty 204 on delete', async () => {
    const { client, calls } = fakeApi(() => new Response(null, { status: 204 }));
    await client.deleteWebhook('w/1');
    assert.equal(calls[0].url.pathname, '/external/v1/webhooks/w%2F1');
  });

  it('keeps the recording hint off other 404s', async () => {
    const { client } = fakeApi(() => new Response('', { status: 404 }));
    await assert.rejects(client.deleteWebhook('gone'), (error: Error) => !/recording_id/.test(error.message) && /webhooks\/gone/.test(error.message));
  });

  it('reports a body that is not JSON', async () => {
    const { client } = fakeApi(() => new Response('<html>proxy</html>', { status: 200 }));
    await assert.rejects(client.listTeams(), /not JSON.*proxy/);
  });

  it('fails fast when Retry-After exceeds what it will wait', async () => {
    const { client, calls } = fakeApi(() => new Response('', { status: 429, headers: { 'Retry-After': '45' } }));
    await assert.rejects(client.listTeams(), /after 0 retries, and Fathom asks to wait 45 s/);
    assert.equal(calls.length, 1);
  });

  it('keeps earlier pages when a later page has an empty body', async () => {
    const pages = pagedMeetings(Array.from({ length: 20 }, (_, i) => meeting(i + 1)));
    const { client } = fakeApi(url => (url.searchParams.get('cursor') ? new Response('', { status: 200 }) : pages(url)));
    const result = await client.listMeetings({}, 20);
    assert.equal(result.items.length, 10);
    assert.match(result.error!, /without items/);
  });
});
