import { createRequire } from 'node:module';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { FathomClient, type Meeting, type MeetingFilters, type TranscriptEntry } from './fathom.js';
import {
  DATE_RANGES,
  anyIncludes,
  linkPath,
  meetingDate,
  meetingUrl,
  peopleOf,
  SEARCH_FIELDS,
  dateRangeBounds,
  formatMeeting,
  formatTranscriptLine,
  matchMeeting,
  inviteeMatches,
  queryWords,
  transcriptSnippets
} from './format.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export const INSTRUCTIONS = `Fathom meeting recordings, read through the Fathom API with the user's API key. Results cover meetings the user recorded or that were shared with them or their team.

Base every statement about what was said or decided on a summary, transcript or search snippet from this server, never on a meeting title or on memory.

- recording_id comes from list_meetings or search_meetings. For a pasted fathom.video link or call ID, use find_meeting_by_link: the number in a /calls/<id> link is not a recording_id.
- Look up exact names with list_teams, list_team_members and list_meeting_types before filtering by team, recorder or meeting type.
- Fathom has no server-side search. search_meetings scans meetings page by page (10 per request, 60 requests per minute), so give it a date range when you can and continue with next_cursor.
- Pass the meeting url to get_meeting_transcript to get timestamped links into the recording.
- create_webhook sends meeting data to an outside URL. Confirm the URL with the user first.`;

// Scans stop after this so the tool answers inside Claude Desktop's 240 s tool-call timeout.
const SCAN_BUDGET_MS = 120_000;
const TRANSCRIPT_CACHE_MS = 10 * 60_000;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

const recordingId = z.number().int().positive().describe('recording_id from list_meetings or search_meetings');

const filterShape = {
  date_range: z.enum(DATE_RANGES).optional().describe('Shortcut for created_after/created_before. Explicit created_after/created_before override the matching bound.'),
  created_after: z.string().optional().describe('ISO 8601 timestamp, e.g. 2026-01-31T00:00:00Z'),
  created_before: z.string().optional().describe('ISO 8601 timestamp'),
  calendar_invitees_domains: z.array(z.string()).optional().describe("Company domains, exact match, e.g. ['acme.com']. Fathom links each meeting to one company."),
  calendar_invitees_domains_type: z
    .enum(['all', 'only_internal', 'one_or_more_external'])
    .optional()
    .describe('Internal/external split, derived from the full calendar invite, including invitees not listed in attendees. Omit unless the user asks for internal-only or external meetings.'),
  meeting_type: z.string().optional().describe('Exact meeting type name from list_meeting_types'),
  recorded_by: z.array(z.string()).optional().describe('Emails of the people who recorded the meetings'),
  teams: z.array(z.string()).optional().describe('Exact team names from list_teams')
};

const includeShape = {
  include_summary: z.boolean().default(false).describe('Add each meeting\'s AI summary (Markdown)'),
  include_action_items: z.boolean().default(false).describe('Add action items with assignee and completion'),
  include_highlights: z.boolean().default(false).describe('Add highlights (bookmarked moments) with links'),
  include_crm_matches: z.boolean().default(false).describe('Add CRM contacts, companies and deals'),
  summary_max_chars: z.number().int().min(100).optional().describe('Truncate each summary to this many characters'),
  response_format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe('concise: id, title, date, duration, url, attendee names. detailed adds attendee emails, recorder, language, sharing and join URL.')
};

type Filters = { [K in keyof typeof filterShape]?: z.infer<(typeof filterShape)[K]> };

function apiFilters({ date_range, ...filters }: Filters): MeetingFilters {
  const range: { created_after?: string; created_before?: string } = date_range ? dateRangeBounds(date_range) : {};
  return {
    ...filters,
    created_after: filters.created_after ?? range.created_after,
    created_before: filters.created_before ?? range.created_before,
    calendar_invitees_domains: filters.calendar_invitees_domains?.map(d => d.toLowerCase())
  };
}

type Includes = Pick<MeetingFilters, 'include_summary' | 'include_action_items' | 'include_highlights' | 'include_crm_matches'>;

function splitIncludes<T extends Includes>({ include_summary, include_action_items, include_highlights, include_crm_matches, ...filters }: T) {
  return { includes: { include_summary, include_action_items, include_highlights, include_crm_matches }, filters };
}

function resourceId(value: string | string[]): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid recording_id: ${value}`);
  return id;
}

export function createServer(client: FathomClient): McpServer {
  const server = new McpServer({ name: 'mcp-fathom-server', version }, { instructions: INSTRUCTIONS });

  // Paging through one transcript with `start` would otherwise re-download it for every page,
  // and transcripts count against Fathom's tighter limit.
  let lastTranscript: { id: number; at: number; entries: Promise<TranscriptEntry[]> } | undefined;
  const transcriptOf = (id: number) => {
    if (lastTranscript?.id !== id || Date.now() - lastTranscript.at > TRANSCRIPT_CACHE_MS) {
      const entries = client.getTranscript(id);
      // A failed or empty download is not kept: an empty transcript may still be processing.
      const forget = () => {
        if (lastTranscript?.entries === entries) lastTranscript = undefined;
      };
      entries.then(list => list.length || forget(), forget);
      lastTranscript = { id, at: Date.now(), entries };
    }
    return lastTranscript.entries;
  };

  server.registerTool(
    'list_meetings',
    {
      title: 'List meetings',
      description:
        'List Fathom meetings, newest first, with optional filters. Returns recording_id, title, date, duration, share URL and attendees, plus summaries, action items, highlights or CRM matches on request. For transcripts use get_meeting_transcript. Continue with next_cursor.',
      inputSchema: z.object({
        ...filterShape,
        ...includeShape,
        limit: z.number().int().min(1).max(100).default(20).describe('Meetings to return'),
        cursor: z.string().optional().describe('next_cursor from the previous response')
      }),
      annotations: READ
    },
    async ({ limit, cursor, response_format, summary_max_chars, ...rest }) => {
      const { includes, filters } = splitIncludes(rest);
      const { items, next_cursor, error } = await client.listMeetings({ ...apiFilters(filters), ...includes }, limit, cursor);
      const options = { ...includes, summary_max_chars, detailed: response_format === 'detailed' };
      return json({
        count: items.length,
        meetings: items.map(m => formatMeeting(m, options)),
        next_cursor,
        ...(error ? { error: `Stopped early: ${error}` } : {})
      });
    }
  );

  server.registerTool(
    'search_meetings',
    {
      title: 'Search meetings',
      description:
        'Find meetings by keywords and/or attendee. Fathom has no search endpoint, so this scans meetings newest first (10 per API request) and matches locally. A meeting matches when every query word appears somewhere in the searched fields (case-insensitive). Transcript matches come with timestamped snippets. If the scan ends before the date range does, continue with next_cursor.',
      inputSchema: z.object({
        query: z.string().trim().optional().describe("Keywords, e.g. 'pricing renewal'. Every word must appear."),
        attendee: z.string().trim().toLowerCase().optional().describe('Name or email fragment of a calendar invitee, e.g. jane@acme.com or Jane'),
        search_in: z
          .array(z.enum(SEARCH_FIELDS))
          .min(1)
          .default(['title', 'summary'])
          .describe('Fields the query must be found in. transcript is the most thorough and the heaviest on the rate limit.'),
        ...filterShape,
        ...includeShape,
        max_scan: z.number().int().min(10).max(500).default(100).describe('Meetings to scan in this call'),
        limit: z.number().int().min(1).max(100).default(20).describe('Stop once this many matches are found'),
        cursor: z.string().optional().describe('next_cursor from the previous search with the same arguments')
      }),
      annotations: READ
    },
    async ({ query, attendee, search_in, max_scan, limit, cursor, response_format, summary_max_chars, ...rest }) => {
      const words = queryWords(query ?? '');
      if (!words.length && !attendee) return fail('Give a query, an attendee, or both.');
      const { includes, filters } = splitIncludes(rest);
      const searched = words.length ? search_in : [];
      const options = { ...includes, summary_max_chars, detailed: response_format === 'detailed' };
      const deadline = Date.now() + SCAN_BUDGET_MS;
      const matches: Array<Record<string, unknown>> = [];
      const collectMatch = (meeting: Meeting) => {
        if (attendee && !meeting.calendar_invitees?.some(i => inviteeMatches(i, attendee))) return;
        const fields = words.length ? matchMeeting(meeting, words, searched) : [];
        if (!fields) return;
        const match = formatMeeting(meeting, options);
        if (fields.length) match.matched_in = fields;
        if (fields.includes('transcript')) match.transcript_snippets = transcriptSnippets(meeting, words);
        matches.push(match);
      };

      const scan = await client.listMeetings(
        {
          ...apiFilters(filters),
          include_summary: includes.include_summary || searched.includes('summary'),
          include_action_items: includes.include_action_items || searched.includes('action_items'),
          include_highlights: includes.include_highlights || searched.includes('highlights'),
          include_transcript: searched.includes('transcript'),
          include_crm_matches: includes.include_crm_matches
        },
        max_scan,
        cursor,
        meeting => {
          collectMatch(meeting);
          // Only the count and the oldest date are read later, so drop the heavy fields now.
          meeting.transcript = meeting.default_summary = meeting.action_items = meeting.highlights = meeting.crm_matches = null;
          return matches.length >= limit || Date.now() > deadline;
        }
      );

      const oldest = scan.items.at(-1);
      return json({
        meetings: matches,
        scanned: scan.items.length,
        oldest_scanned_created_at: oldest ? oldest.created_at : null,
        next_cursor: scan.next_cursor,
        ...(scan.error ? { error: `Scan stopped early: ${scan.error}` } : {}),
        ...(scan.next_cursor ? { note: 'More meetings remain in the date range. Continue with next_cursor.' } : {})
      });
    }
  );

  server.registerTool(
    'find_meeting_by_link',
    {
      title: 'Find meeting by link',
      description:
        'Resolve a pasted Fathom link (fathom.video/calls/<id> or fathom.video/share/<token>) or a bare call ID to its meeting, including recording_id and the public share URL. Scans the most recent meetings, 10 per request.',
      inputSchema: z.object({
        link: z.string().trim().min(1).describe('A fathom.video/calls/ or /share/ URL, or the numeric call ID from a /calls/ URL'),
        max_scan: z.number().int().min(10).max(1000).default(300).describe('Recent meetings to scan')
      }),
      annotations: READ
    },
    async ({ link, max_scan }) => {
      const path = /^\d+$/.test(link) ? `/calls/${link}` : linkPath(link);
      if (!path) return fail('Not a fathom.video /calls/ or /share/ link or a numeric call ID.');
      const deadline = Date.now() + SCAN_BUDGET_MS;
      let found: Meeting | undefined;
      const scan = await client.listMeetings({}, max_scan, undefined, meeting => {
        if (linkPath(meeting.url) === path || linkPath(meeting.share_url) === path) found = meeting;
        return !!found || Date.now() > deadline;
      });
      if (found) return json(formatMeeting(found, { detailed: true }));
      const stopped = scan.error ?? (Date.now() > deadline ? 'time limit reached' : undefined);
      return fail(
        `No meeting with this link among the ${scan.items.length} most recent meetings.${stopped ? ` Scan stopped early: ${stopped}.` : ''} Raise max_scan, or ask the user for the meeting date and use list_meetings with created_after and created_before.`
      );
    }
  );

  server.registerTool(
    'get_meeting_summary',
    {
      title: 'Get meeting summary',
      description: "Get one meeting's AI summary as Markdown.",
      inputSchema: z.object({ recording_id: recordingId }),
      annotations: READ
    },
    async ({ recording_id }) => {
      const summary = await client.getSummary(recording_id);
      return text(summary?.markdown_formatted ?? 'This meeting has no summary.');
    }
  );

  server.registerTool(
    'get_meeting_transcript',
    {
      title: 'Get meeting transcript',
      description:
        'Get a meeting transcript, one line per speaker turn: "[MM:SS] Speaker: text". Pass the meeting url from list_meetings to turn each timestamp into a link to that moment. Long transcripts are paged with start and max_entries.',
      inputSchema: z.object({
        recording_id: recordingId,
        url: z.url({ protocol: /^https?$/ }).optional().describe('The meeting url from list_meetings or search_meetings'),
        start: z.number().int().min(0).default(0).describe('Index of the first entry to return'),
        max_entries: z.number().int().min(1).max(5000).default(1000).describe('Entries to return')
      }),
      annotations: READ,
      _meta: { 'anthropic/maxResultSizeChars': 500_000 }
    },
    async ({ recording_id, url, start, max_entries }) => {
      const transcript = await transcriptOf(recording_id);
      if (!transcript.length) return text('This meeting has no transcript.');
      const entries = transcript.slice(start, start + max_entries);
      if (!entries.length) return fail(`start=${start} is past the end. The transcript has ${transcript.length} entries.`);
      const end = start + entries.length;
      const more = end < transcript.length ? ` Continue with start=${end}.` : '';
      const header = `Entries ${start}-${end - 1} of ${transcript.length}.${more}`;
      return text([header, ...entries.map(entry => formatTranscriptLine(entry, url))].join('\n'));
    }
  );

  server.registerTool(
    'list_teams',
    { title: 'List teams', description: 'List all team names in the Fathom organization.', annotations: READ },
    async () => {
      const teams = await client.listTeams();
      return json({ count: teams.length, teams: teams.map(t => t.name) });
    }
  );

  server.registerTool(
    'list_team_members',
    {
      title: 'List team members',
      description: 'List members of the Fathom organization, optionally for one team.',
      inputSchema: z.object({ team: z.string().optional().describe('Exact team name from list_teams') }),
      annotations: READ
    },
    async ({ team }) => {
      const members = await client.listTeamMembers(team, Date.now() + SCAN_BUDGET_MS);
      return json({ count: members.length, members: members.map(m => ({ name: m.name, email: m.email })) });
    }
  );

  server.registerTool(
    'list_meeting_types',
    {
      title: 'List meeting types',
      description: "List the organization's meeting types, the valid values for the meeting_type filter.",
      annotations: READ
    },
    async () => {
      const types = await client.listMeetingTypes();
      return json({ count: types.length, meeting_types: types.map(t => ({ name: t.name, status: t.status })) });
    }
  );

  server.registerTool(
    'find_person',
    {
      title: 'Find person',
      description:
        'Find people by name or email fragment among meeting speakers, calendar invitees and the team roster. Returns email, whether they are external, how many of the scanned meetings they joined or spoke in, and their latest meeting with its share URL. Scans the most recent meetings with their transcripts.',
      inputSchema: z.object({
        name: z.string().trim().toLowerCase().min(1).describe('Name or email fragment, case-insensitive'),
        max_scan: z.number().int().min(10).max(200).default(100).describe('Recent meetings to search. Each 10 cost one of the 30 transcript requests Fathom allows per minute.')
      }),
      annotations: READ
    },
    async ({ name, max_scan }) => {
      const deadline = Date.now() + SCAN_BUDGET_MS;
      let rosterError: string | undefined;
      const roster = client.listTeamMembers(undefined, deadline).catch((error: Error) => {
        rosterError = error.message;
        return [];
      });

      const scan = await client
        // Transcripts name the speakers.
        .listMeetings({ include_transcript: true }, max_scan, undefined, () => Date.now() > deadline)
        .catch((error: Error) => ({ items: [] as Meeting[], error: error.message }));
      const stopped = scan.error ?? (scan.items.length < max_scan && Date.now() > deadline ? 'time limit reached' : undefined);

      const members = (await roster).filter(m => anyIncludes([m.name, m.email], name));
      // Newest first, so the first meeting seen for a person is their latest.
      const seen = scan.items.flatMap(meeting => peopleOf(meeting).filter(p => anyIncludes([p.name, p.email, ...(p.aliases ?? [])], name)).map(p => ({ meeting, p })));
      // A name shown without an email, such as an unmatched speaker, joins the one email seen with that name.
      const emailByName = new Map<string, string | null>();
      const named = [...members.map(m => ({ names: [m.name], email: m.email })), ...seen.map(({ p }) => ({ names: [p.name, ...(p.aliases ?? [])], email: p.email }))];
      for (const { names, email } of named) {
        for (const n of names) {
          if (!n || !email) continue;
          const known = emailByName.get(n.toLowerCase());
          emailByName.set(n.toLowerCase(), known === undefined || known === email.toLowerCase() ? email.toLowerCase() : null);
        }
      }
      const keyOf = (email: string | null, n: string | null) => (email || (n && emailByName.get(n.toLowerCase())) || n || '').toLowerCase();

      const people = new Map<string, Record<string, unknown> & { meetings: number; spoke_in: number }>();
      for (const m of members) people.set(keyOf(m.email, m.name), { name: m.name, email: m.email, team_member: true, meetings: 0, spoke_in: 0 });
      // Two entries of one meeting can resolve to the same person, so each meeting counts once.
      const counted = new Map<string, { id: number; spoke: boolean }>();
      for (const { meeting, p } of seen) {
        const key = keyOf(p.email, p.name);
        const person = people.get(key) ?? { name: p.name, email: p.email, meetings: 0, spoke_in: 0 };
        person.email ||= p.email;
        person.external ??= p.external ?? undefined;
        const last = counted.get(key);
        const again = last?.id === meeting.recording_id;
        if (!again) person.meetings += 1;
        if (p.spoke && !(again && last.spoke)) person.spoke_in += 1;
        counted.set(key, { id: meeting.recording_id, spoke: p.spoke || (again && last.spoke) });
        person.latest_meeting ??= { recording_id: meeting.recording_id, title: meeting.title || meeting.meeting_title, date: meetingDate(meeting), url: meetingUrl(meeting) };
        people.set(key, person);
      }
      const matches = [...people.values()].sort((a, b) => b.meetings - a.meetings);
      return json({
        matches: matches.slice(0, 25),
        ...(matches.length > 25 ? { note: `${matches.length - 25} more people match. Use a longer name fragment.` } : {}),
        scanned_meetings: scan.items.length,
        ...(stopped ? { error: `Meeting scan stopped early: ${stopped}` } : {}),
        ...(rosterError ? { roster_error: `Team roster not searched: ${rosterError}` } : {})
      });
    }
  );

  server.registerTool(
    'create_webhook',
    {
      title: 'Create webhook',
      description:
        'Register a URL that Fathom POSTs each new meeting to once its summary is ready. Confirm the URL with the user first: it receives real meeting data. Returns the webhook id and signing secret, which Fathom never shows again.',
      inputSchema: z.object({
        destination_url: z.url({ protocol: /^https$/ }).describe('HTTPS endpoint that receives the meeting payload'),
        triggered_for: z
          .array(z.enum(['my_recordings', 'shared_external_recordings', 'my_shared_with_team_recordings', 'shared_team_recordings']))
          .min(1)
          .describe(
            "Recordings that fire the webhook. my_recordings: the user's own. shared_external_recordings: shared with the user by others. my_shared_with_team_recordings and shared_team_recordings: Team Plans only."
          ),
        include_summary: z.boolean().default(false),
        include_transcript: z.boolean().default(false),
        include_action_items: z.boolean().default(false),
        include_crm_matches: z.boolean().default(false)
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async params => {
      if (!params.include_summary && !params.include_transcript && !params.include_action_items && !params.include_crm_matches) {
        return fail('Set at least one include_* option to true.');
      }
      const webhook = await client.createWebhook(params);
      return json({
        webhook,
        note: 'Store id and secret now. Fathom has no endpoint to list webhooks or read the secret again. Deliveries are signed per the Standard Webhooks spec with this secret.'
      });
    }
  );

  server.registerTool(
    'delete_webhook',
    {
      title: 'Delete webhook',
      description: 'Delete a webhook by the id create_webhook returned. Webhooks without a known id can only be removed in Fathom settings.',
      inputSchema: z.object({ webhook_id: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ webhook_id }) => {
      await client.deleteWebhook(webhook_id);
      return json({ deleted: webhook_id });
    }
  );

  server.registerResource(
    'meeting-summary',
    new ResourceTemplate('fathom://recordings/{recording_id}/summary', { list: undefined }),
    { title: 'Meeting summary', description: "One meeting's AI summary", mimeType: 'text/markdown' },
    async (uri, { recording_id }) => {
      const summary = await client.getSummary(resourceId(recording_id));
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: summary?.markdown_formatted ?? '' }] };
    }
  );

  server.registerResource(
    'meeting-transcript',
    new ResourceTemplate('fathom://recordings/{recording_id}/transcript', { list: undefined }),
    { title: 'Meeting transcript', description: 'One meeting transcript, one line per speaker turn', mimeType: 'text/plain' },
    async (uri, { recording_id }) => {
      const transcript = await transcriptOf(resourceId(recording_id));
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: transcript.map(e => formatTranscriptLine(e)).join('\n') }] };
    }
  );

  server.registerPrompt(
    'meeting_prep',
    {
      title: 'Prepare for a meeting',
      description: 'Brief me on past meetings with a person or company',
      argsSchema: z.object({ who: z.string().describe('Name, email or company domain') })
    },
    ({ who }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Prepare me for my next meeting with ${who}. For a person use search_meetings with attendee, for a company domain use list_meetings with calendar_invitees_domains, both over date_range last_90_days with include_summary and include_action_items. Brief me on: what we discussed, what was decided, open action items and who owns them, and open questions. Link each point to its meeting.`
          }
        }
      ]
    })
  );

  server.registerPrompt(
    'meeting_recap',
    {
      title: 'Recap my meetings',
      description: 'Decisions and open action items across recent meetings',
      argsSchema: z.object({ period: z.enum(DATE_RANGES).optional().describe('Default: last_7_days') })
    },
    ({ period }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Recap my meetings for date_range ${period ?? 'last_7_days'}. Use list_meetings with include_summary and include_action_items. Group by topic: key decisions, open action items with owners, and follow-ups I owe. Link each point to its meeting.`
          }
        }
      ]
    })
  );

  return server;
}
