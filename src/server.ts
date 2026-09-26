import { createRequire } from 'node:module';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { FathomClient, type MeetingFilters } from './fathom.js';
import {
  DATE_RANGES,
  SEARCH_FIELDS,
  dateRangeBounds,
  formatMeeting,
  formatTranscriptLine,
  matchMeeting,
  matchesAttendee,
  queryWords,
  transcriptSnippets
} from './format.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export const INSTRUCTIONS = `Fathom meeting recordings, read through the Fathom API with the user's API key. Results cover meetings the user recorded or that were shared with them or their team.

Base every statement about what was said or decided on a summary, transcript or search snippet from this server, never on a meeting title or on memory.

- recording_id comes from list_meetings or search_meetings. The number in a fathom.video/calls/<id> link is a different ID.
- Look up exact names with list_teams, list_team_members and list_meeting_types before filtering by team, recorder or meeting type.
- Fathom has no server-side search. search_meetings scans meetings page by page (10 per request, 60 requests per minute), so give it a date range when you can and continue with next_cursor.
- Pass the meeting url to get_meeting_transcript to get timestamped links into the recording.
- create_webhook sends meeting data to an outside URL. Confirm the URL with the user first.`;

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

function peopleKey(email: string | null, name: string): string {
  return (email || name).toLowerCase();
}

export function createServer(client: FathomClient): McpServer {
  const server = new McpServer({ name: 'mcp-fathom-server', version }, { instructions: INSTRUCTIONS });

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
      const { include_summary, include_action_items, include_highlights, include_crm_matches, ...filters } = rest;
      const includes = { include_summary, include_action_items, include_highlights, include_crm_matches };
      const { items, next_cursor } = await client.listMeetings({ ...apiFilters(filters), ...includes }, limit, cursor);
      const options = { ...includes, summary_max_chars, detailed: response_format === 'detailed' };
      return json({ count: items.length, meetings: items.map(m => formatMeeting(m, options)), next_cursor });
    }
  );

  server.registerTool(
    'search_meetings',
    {
      title: 'Search meetings',
      description:
        'Find meetings by keywords and/or attendee. Fathom has no search endpoint, so this scans meetings newest first (10 per API request) and matches locally. A meeting matches when every query word appears somewhere in the searched fields (case-insensitive). Transcript matches come with timestamped snippets. If the scan ends before the date range does, continue with next_cursor.',
      inputSchema: z.object({
        query: z.string().optional().describe("Keywords, e.g. 'pricing renewal'. Every word must appear."),
        attendee: z.string().optional().describe('Name or email fragment of a calendar invitee, e.g. jane@acme.com or Jane'),
        search_in: z
          .array(z.enum(SEARCH_FIELDS))
          .min(1)
          .default(['title', 'summary'])
          .describe('Fields the query must be found in. transcript is the most thorough and the heaviest on the rate limit.'),
        ...filterShape,
        ...includeShape,
        max_scan: z.number().int().min(10).max(500).default(100).describe('Meetings to scan in this call'),
        limit: z.number().int().min(1).max(100).default(20).describe('Matches to return'),
        cursor: z.string().optional().describe('next_cursor from the previous search with the same arguments')
      }),
      annotations: READ
    },
    async ({ query, attendee, search_in, max_scan, limit, cursor, response_format, summary_max_chars, ...rest }) => {
      const words = queryWords(query ?? '');
      if (!words.length && !attendee?.trim()) return fail('Give a query, an attendee, or both.');
      const { include_summary, include_action_items, include_highlights, include_crm_matches, ...filters } = rest;
      const searched = words.length ? search_in : [];
      const scan = await client.listMeetings(
        {
          ...apiFilters(filters),
          include_summary: include_summary || searched.includes('summary'),
          include_action_items: include_action_items || searched.includes('action_items'),
          include_highlights: include_highlights || searched.includes('highlights'),
          include_transcript: searched.includes('transcript'),
          include_crm_matches
        },
        max_scan,
        cursor
      );

      const options = {
        include_summary,
        include_action_items,
        include_highlights,
        include_crm_matches,
        summary_max_chars,
        detailed: response_format === 'detailed'
      };
      const matches: Array<Record<string, unknown>> = [];
      for (const meeting of scan.items) {
        if (attendee && !matchesAttendee(meeting, attendee.trim())) continue;
        const fields = words.length ? matchMeeting(meeting, words, searched) : [];
        if (!fields) continue;
        const match = formatMeeting(meeting, options);
        if (fields.length) match.matched_in = fields;
        if (fields.includes('transcript')) match.transcript_snippets = transcriptSnippets(meeting, words);
        matches.push(match);
      }

      const oldest = scan.items.at(-1);
      return json({
        total_matches: matches.length,
        meetings: matches.slice(0, limit),
        scanned: scan.items.length,
        scanned_back_to: oldest ? oldest.created_at : null,
        next_cursor: scan.next_cursor,
        ...(matches.length > limit ? { note: `${matches.length - limit} more matches in this scan. Raise limit or narrow the query.` } : {})
      });
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
      const { summary } = await client.getSummary(recording_id);
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
        url: z.string().url().optional().describe('The meeting url from list_meetings or search_meetings'),
        start: z.number().int().min(0).default(0).describe('Index of the first entry to return'),
        max_entries: z.number().int().min(1).max(5000).default(1000).describe('Entries to return')
      }),
      annotations: READ,
      _meta: { 'anthropic/maxResultSizeChars': 500_000 }
    },
    async ({ recording_id, url, start, max_entries }) => {
      const { transcript } = await client.getTranscript(recording_id);
      if (!transcript?.length) return text('This meeting has no transcript.');
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
      const members = await client.listTeamMembers(team);
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
        "Find people by name or email fragment in the team roster and among calendar invitees of recent meetings. Returns email, whether they are external, and their latest meeting. People who only spoke in a meeting without being invited are not found.",
      inputSchema: z.object({
        name: z.string().min(1).describe('Name or email fragment, case-insensitive'),
        max_scan: z.number().int().min(10).max(500).default(100).describe('Recent meetings to scan for invitees')
      }),
      annotations: READ
    },
    async ({ name, max_scan }) => {
      const needle = name.trim().toLowerCase();
      const hit = (value: string | null | undefined) => !!value && value.toLowerCase().includes(needle);
      const [members, scan] = await Promise.all([client.listTeamMembers(), client.listMeetings({}, max_scan)]);

      const people = new Map<string, Record<string, unknown> & { meetings: number }>();
      for (const m of members) {
        if (hit(m.name) || hit(m.email)) people.set(peopleKey(m.email, m.name), { name: m.name, email: m.email, source: 'team', meetings: 0 });
      }
      for (const meeting of scan.items) {
        for (const invitee of meeting.calendar_invitees ?? []) {
          if (!hit(invitee.name) && !hit(invitee.email) && !hit(invitee.matched_speaker_display_name)) continue;
          const key = peopleKey(invitee.email, invitee.name ?? '');
          const person = people.get(key) ?? { name: invitee.name, email: invitee.email, source: 'invitee', meetings: 0 };
          person.external = invitee.is_external;
          person.meetings += 1;
          // Meetings arrive newest first, so the first one seen is the latest.
          person.latest_meeting ??= { recording_id: meeting.recording_id, title: meeting.title, date: meeting.scheduled_start_time || meeting.created_at };
          people.set(key, person);
        }
      }
      return json({ matches: [...people.values()], scanned_meetings: scan.items.length });
    }
  );

  server.registerTool(
    'create_webhook',
    {
      title: 'Create webhook',
      description:
        'Register a URL that Fathom POSTs each new meeting to once its summary is ready. Confirm the URL with the user first: it receives real meeting data. Returns the webhook id and signing secret, which Fathom never shows again.',
      inputSchema: z.object({
        destination_url: z.string().url().describe('HTTPS endpoint that receives the meeting payload'),
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
      const { summary } = await client.getSummary(Number(recording_id));
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: summary?.markdown_formatted ?? '' }] };
    }
  );

  server.registerResource(
    'meeting-transcript',
    new ResourceTemplate('fathom://recordings/{recording_id}/transcript', { list: undefined }),
    { title: 'Meeting transcript', description: 'One meeting transcript, one line per speaker turn', mimeType: 'text/plain' },
    async (uri, { recording_id }) => {
      const { transcript } = await client.getTranscript(Number(recording_id));
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: (transcript ?? []).map(e => formatTranscriptLine(e)).join('\n') }] };
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
            text: `Prepare me for my next meeting with ${who}. Use search_meetings (attendee, or calendar_invitees_domains for a domain) over the last 90 days with include_summary and include_action_items. Brief me on: what we discussed, what was decided, open action items and who owns them, and open questions. Link each point to its meeting.`
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
