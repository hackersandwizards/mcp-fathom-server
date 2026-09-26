export const FATHOM_API_BASE_URL = 'https://api.fathom.ai/external/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;
// Retry-After above this is capped so one tool call stays inside Claude Desktop's 240 s timeout.
const MAX_RETRY_WAIT_MS = 30_000;
const MAX_LIST_PAGES = 50;

export type TriggeredFor =
  | 'my_recordings'
  | 'shared_external_recordings'
  | 'my_shared_with_team_recordings'
  | 'shared_team_recordings';

export interface TranscriptEntry {
  speaker: { display_name: string; matched_calendar_invitee_email: string | null };
  text: string;
  timestamp: string;
}

export interface Summary {
  template_name: string | null;
  markdown_formatted: string | null;
}

export interface ActionItem {
  description: string;
  user_generated: boolean;
  completed: boolean;
  recording_timestamp: string;
  recording_playback_url: string;
  assignee: { name: string | null; email: string | null; team: string | null };
}

export interface Highlight {
  type: string;
  summary: string | null;
  text?: string;
  start_time: number;
  end_time: number;
}

export interface CalendarInvitee {
  name: string | null;
  email: string | null;
  email_domain: string | null;
  is_external: boolean;
  matched_speaker_display_name: string | null;
}

export interface CrmMatches {
  contacts: Array<{ name: string; email: string; record_url: string }>;
  companies: Array<{ name: string; record_url: string }>;
  deals: Array<{ name: string; amount: number; record_url: string }>;
  error: string | null;
}

export interface Meeting {
  title: string;
  meeting_title: string | null;
  meeting_type?: string | null;
  recording_id: number;
  url: string;
  meeting_url?: string | null;
  share_url: string;
  created_at: string;
  scheduled_start_time: string;
  scheduled_end_time: string;
  recording_start_time: string;
  recording_end_time: string;
  calendar_invitees_domains_type: 'only_internal' | 'one_or_more_external';
  shared_with?: 'no_teams' | 'single_team' | 'multiple_teams' | 'all_teams';
  transcript_language: string;
  calendar_invitees: CalendarInvitee[];
  recorded_by: { name: string; email: string; email_domain: string; team: string | null };
  transcript?: TranscriptEntry[] | null;
  default_summary?: Summary | null;
  action_items?: ActionItem[] | null;
  highlights?: Highlight[] | null;
  crm_matches?: CrmMatches | null;
}

export interface MeetingFilters {
  created_after?: string;
  created_before?: string;
  calendar_invitees_domains?: string[];
  calendar_invitees_domains_type?: 'all' | 'only_internal' | 'one_or_more_external';
  meeting_type?: string;
  recorded_by?: string[];
  teams?: string[];
  include_summary?: boolean;
  include_transcript?: boolean;
  include_action_items?: boolean;
  include_highlights?: boolean;
  include_crm_matches?: boolean;
}

export interface Team { name: string; created_at: string }
export interface TeamMember { name: string; email: string; created_at: string }
export interface MeetingType { name: string; status: 'active' | 'inactive'; created_at: string }

export interface Webhook {
  id: string;
  url: string;
  secret: string;
  created_at: string;
  include_transcript: boolean;
  include_summary: boolean;
  include_action_items: boolean;
  include_crm_matches: boolean;
  triggered_for: TriggeredFor[];
}

interface Page<T> { items: T[]; next_cursor: string | null }
type Query = Record<string, string | number | boolean | string[] | undefined>;

export class FathomApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

// Our cursor wraps Fathom's page cursor plus an offset into that page, so a
// limit that ends mid-page (Fathom's page size is fixed at 10) loses no meetings.
interface Position { c?: string; s: number }

function encodeCursor({ c, s }: Position): string {
  return `${s}.${c ?? ''}`;
}

function decodeCursor(cursor?: string): Position {
  if (!cursor) return { s: 0 };
  const match = /^(\d+)\.(.*)$/.exec(cursor);
  if (!match) throw new FathomApiError('Invalid cursor. Pass next_cursor exactly as a previous response returned it.');
  return { s: Number(match[1]), c: match[2] || undefined };
}

export class FathomClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  ) {}

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, query: Query = {}, body?: unknown): Promise<T> {
    const url = new URL(FATHOM_API_BASE_URL + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach(v => url.searchParams.append(`${key}[]`, v));
      else url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: { 'X-Api-Key': this.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch (error) {
        // A POST that timed out may have been processed, so only reads retry network failures.
        if (method === 'GET' && attempt < 2) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new FathomApiError(`Could not reach the Fathom API: ${(error as Error).message}`);
      }

      const retryable = response.status === 429 || (method === 'GET' && response.status >= 500);
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        console.error(`[fathom] ${response.status} on ${path}, retrying in ${Math.min(wait, MAX_RETRY_WAIT_MS)} ms`);
        await this.sleep(Math.min(wait, MAX_RETRY_WAIT_MS));
        continue;
      }

      if (!response.ok) throw await this.toError(response, path);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  private async toError(response: Response, path: string): Promise<FathomApiError> {
    const raw = await response.text().catch(() => '');
    let detail = raw.slice(0, 300);
    try {
      const json = JSON.parse(raw);
      detail = json.message ?? json.error ?? JSON.stringify(json.errors ?? json).slice(0, 300);
    } catch {}
    const status = response.status;
    const messages: Record<number, string> = {
      401: 'Fathom rejected the API key (401). Check FATHOM_API_KEY.',
      403: `Fathom denied access to ${path} (403): ${detail}`,
      404: `Not found (404): ${path}. A recording_id must come from list_meetings or search_meetings. The number in a fathom.video/calls/<id> link is a different ID.`,
      429: `Fathom rate limit still exceeded after ${MAX_RETRIES} retries. The limit is 60 requests per minute, and 30 or fewer for summaries and transcripts. Wait a minute or narrow the request.`
    };
    return new FathomApiError(messages[status] ?? `Fathom API error ${status} on ${path}: ${detail}`, status);
  }

  /** Returns up to `limit` items starting at `cursor`, following Fathom's pages as needed. */
  async collect<T>(path: string, query: Query, limit: number, cursor?: string): Promise<{ items: T[]; next_cursor: string | null }> {
    let { c, s } = decodeCursor(cursor);
    const items: T[] = [];
    for (;;) {
      const page = await this.request<Page<T>>('GET', path, { ...query, cursor: c });
      const available = page.items.slice(s);
      const needed = limit - items.length;
      if (available.length > needed) {
        items.push(...available.slice(0, needed));
        return { items, next_cursor: encodeCursor({ c, s: s + needed }) };
      }
      items.push(...available);
      s = 0;
      if (!page.next_cursor) return { items, next_cursor: null };
      c = page.next_cursor;
      if (items.length === limit) return { items, next_cursor: encodeCursor({ c, s: 0 }) };
    }
  }

  private async all<T>(path: string, query: Query = {}): Promise<T[]> {
    return (await this.collect<T>(path, query, MAX_LIST_PAGES * 10)).items;
  }

  listMeetings(filters: MeetingFilters, limit: number, cursor?: string) {
    return this.collect<Meeting>('/meetings', { ...filters }, limit, cursor);
  }

  getSummary(recordingId: number) {
    return this.request<{ summary: Summary }>('GET', `/recordings/${recordingId}/summary`);
  }

  getTranscript(recordingId: number) {
    return this.request<{ transcript: TranscriptEntry[] }>('GET', `/recordings/${recordingId}/transcript`);
  }

  listTeams() {
    return this.all<Team>('/teams');
  }

  listTeamMembers(team?: string) {
    return this.all<TeamMember>('/team_members', { team });
  }

  listMeetingTypes() {
    return this.all<MeetingType>('/meeting_types');
  }

  createWebhook(body: {
    destination_url: string;
    triggered_for: TriggeredFor[];
    include_transcript: boolean;
    include_summary: boolean;
    include_action_items: boolean;
    include_crm_matches: boolean;
  }) {
    return this.request<Webhook>('POST', '/webhooks', {}, body);
  }

  deleteWebhook(id: string) {
    return this.request<void>('DELETE', `/webhooks/${encodeURIComponent(id)}`);
  }
}
