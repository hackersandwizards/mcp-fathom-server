export const FATHOM_API_BASE_URL = 'https://api.fathom.ai/external/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;
// A Retry-After longer than this fails fast instead of retrying before Fathom allows it.
const MAX_RETRY_WAIT_MS = 30_000;
// A retry starts only if its wait plus a full attempt timeout fits in this, so one request ends
// within 75 s and a scan's last request cannot carry a tool call past Claude Desktop's 240 s timeout.
const REQUEST_BUDGET_MS = 75_000;

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

// Our cursor wraps Fathom's page cursor plus an offset into that page, so a limit that ends
// mid-page (Fathom's page size is fixed at 10) loses no meetings. It also names the last item
// returned, so a resume lands after that item even when new meetings shifted the page.
interface Position { c?: string; s: number; a?: string }

function encodeCursor({ c, s, a }: Position): string {
  return `${s}.${a ?? ''}.${c ?? ''}`;
}

function decodeCursor(cursor?: string): Position {
  if (!cursor) return { s: 0 };
  const match = /^(\d+)\.([^.]*)\.(.*)$/.exec(cursor);
  if (!match) throw new FathomApiError('Invalid cursor. Pass next_cursor exactly as a previous response returned it.');
  return { s: Number(match[1]), a: match[2] || undefined, c: match[3] || undefined };
}

function toError(status: number, raw: string, path: string, retries: number, retryAfter: number): FathomApiError {
  let detail = raw.slice(0, 300);
  try {
    const json = JSON.parse(raw);
    const message = json.message ?? json.error;
    detail = typeof message === 'string' ? message : JSON.stringify(json).slice(0, 300);
  } catch {}
  const notFound = path.startsWith('/recordings/')
    ? `Not found (404): ${path}. A recording_id must come from list_meetings or search_meetings. The number in a fathom.video/calls/<id> link is a different ID.`
    : `Not found (404): ${path}. ${detail}`;
  const messages: Record<number, string> = {
    401: 'Fathom rejected the API key (401). Check FATHOM_API_KEY.',
    403: `Fathom denied access to ${path} (403): ${detail}`,
    404: notFound,
    429: `Fathom rate limit still exceeded after ${retries} retries${retryAfter > 0 ? `, and Fathom asks to wait ${retryAfter} s` : ''}. The limit is 60 requests per minute, and 30 or fewer for summaries and transcripts. Wait a minute or narrow the request.`
  };
  return new FathomApiError(messages[status] ?? `Fathom API error ${status} on ${path}: ${detail}`, status);
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

    const started = Date.now();
    const canWait = (ms: number) => Date.now() - started + ms + REQUEST_TIMEOUT_MS <= REQUEST_BUDGET_MS;
    let networkFailures = 0;
    let retries = 0;
    for (;;) {
      let response: Response;
      let raw: string;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: { 'X-Api-Key': this.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        raw = await response.text();
      } catch (error) {
        // A POST that timed out may have been processed, so only reads retry network failures.
        networkFailures++;
        if (method === 'GET' && networkFailures <= 2 && canWait(1000 * networkFailures)) {
          await this.sleep(1000 * networkFailures);
          continue;
        }
        throw new FathomApiError(`Could not reach the Fathom API: ${(error as Error).message}`);
      }

      const retryable = response.status === 429 || (method === 'GET' && response.status >= 500);
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** retries;
      if (retryable && retries < MAX_RETRIES && wait <= MAX_RETRY_WAIT_MS && canWait(wait)) {
        console.error(`[fathom] ${response.status} on ${path}, retrying in ${wait} ms`);
        retries++;
        await this.sleep(wait);
        continue;
      }

      if (!response.ok) throw toError(response.status, raw, path, retries, retryAfter);
      if (!raw) return undefined as T;
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new FathomApiError(`Fathom returned a response that is not JSON on ${path}: ${raw.slice(0, 200)}`);
      }
    }
  }

  /**
   * Returns up to `limit` items starting at `cursor`, following Fathom's pages as needed.
   * `stopAfter` ends the walk early, after the item it returns true for. When a later page fails,
   * the items read so far come back with `error` and a cursor that retries that page.
   */
  async collect<T>(
    path: string,
    query: Query,
    limit: number,
    cursor?: string,
    stopAfter?: (item: T) => boolean,
    keyOf?: (item: T) => string | number
  ): Promise<{ items: T[]; next_cursor: string | null; error?: string }> {
    let { c, s, a } = decodeCursor(cursor);
    const items: T[] = [];
    for (;;) {
      let page: Page<T>;
      try {
        page = await this.request<Page<T>>('GET', path, { ...query, cursor: c });
        if (!Array.isArray(page?.items)) throw new FathomApiError(`Fathom returned a page without items on ${path}.`);
      } catch (error) {
        if (!items.length) throw error;
        return { items, next_cursor: encodeCursor({ c, s }), error: (error as Error).message };
      }
      if (a !== undefined && keyOf) {
        const anchor = page.items.findIndex(item => String(keyOf(item)) === a);
        if (anchor >= 0) s = anchor + 1;
        a = undefined;
      }
      for (; s < page.items.length; s++) {
        items.push(page.items[s]);
        const stop = stopAfter?.(page.items[s]);
        if (items.length >= limit || stop) {
          const anchor = keyOf ? String(keyOf(page.items[s])) : undefined;
          const next = s + 1 < page.items.length ? { c, s: s + 1, a: anchor } : page.next_cursor ? { c: page.next_cursor, s: 0 } : null;
          return { items, next_cursor: next && encodeCursor(next) };
        }
      }
      if (!page.next_cursor) return { items, next_cursor: null };
      c = page.next_cursor;
      s = 0;
    }
  }

  /** Every page, or an error: a silently partial list of names would read as complete. */
  private async all<T>(path: string, query: Query = {}, deadline = Infinity): Promise<T[]> {
    const result = await this.collect<T>(path, query, Infinity, undefined, () => Date.now() > deadline);
    if (result.error) throw new FathomApiError(result.error);
    if (result.next_cursor) throw new FathomApiError(`Stopped reading ${path} at the time limit after ${result.items.length} entries.`);
    return result.items;
  }

  listMeetings(filters: MeetingFilters, limit: number, cursor?: string, stopAfter?: (meeting: Meeting) => boolean) {
    return this.collect<Meeting>('/meetings', { ...filters }, limit, cursor, stopAfter, meeting => meeting.recording_id);
  }

  async getSummary(recordingId: number): Promise<Summary | null> {
    const body = await this.request<{ summary?: Summary } | undefined>('GET', `/recordings/${recordingId}/summary`);
    return body?.summary ?? null;
  }

  async getTranscript(recordingId: number): Promise<TranscriptEntry[]> {
    const body = await this.request<{ transcript?: TranscriptEntry[] } | undefined>('GET', `/recordings/${recordingId}/transcript`);
    return body?.transcript ?? [];
  }

  listTeams() {
    return this.all<Team>('/teams');
  }

  listTeamMembers(team?: string, deadline?: number) {
    return this.all<TeamMember>('/team_members', { team }, deadline);
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
