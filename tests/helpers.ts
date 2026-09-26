import { FathomClient, type Meeting } from '../src/fathom.js';

export function meeting(id: number, overrides: Partial<Meeting> = {}): Meeting {
  return {
    title: `Meeting ${id}`,
    meeting_title: null,
    recording_id: id,
    url: `https://fathom.video/calls/${id}`,
    share_url: `https://fathom.video/share/s${id}`,
    created_at: '2026-01-01T10:00:00Z',
    scheduled_start_time: '2026-01-01T10:00:00Z',
    scheduled_end_time: '2026-01-01T11:00:00Z',
    recording_start_time: '2026-01-01T10:00:00Z',
    recording_end_time: '2026-01-01T10:45:00Z',
    calendar_invitees_domains_type: 'only_internal',
    transcript_language: 'en',
    calendar_invitees: [],
    recorded_by: { name: 'Rec', email: 'rec@example.com', email_domain: 'example.com', team: null },
    ...overrides
  };
}

export interface Call { url: URL; init: RequestInit }

/** A fetch double that answers from `route` and records every request. */
export function fakeApi(route: (url: URL, init: RequestInit, n: number) => Response | object) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    calls.push({ url: input, init });
    const out = route(input, init, calls.length);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  const client = new FathomClient('test-key', fetchImpl, async () => {});
  return { client, calls };
}

/** Serves `meetings` in Fathom's fixed pages of 10, with page cursors "p1", "p2", ... */
export function pagedMeetings(meetings: Meeting[]) {
  return (url: URL) => {
    const page = Number(url.searchParams.get('cursor')?.slice(1) ?? 0);
    const items = meetings.slice(page * 10, page * 10 + 10);
    return { limit: 10, items, next_cursor: (page + 1) * 10 < meetings.length ? `p${page + 1}` : null };
  };
}
