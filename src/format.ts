import type { Meeting, TranscriptEntry } from './fathom.js';

export const DATE_RANGES = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days'] as const;
export type DateRange = (typeof DATE_RANGES)[number];

/** Day boundaries use the local time zone of the machine running the server. */
export function dateRangeBounds(range: DateRange, now = new Date()): { created_after: string; created_before?: string } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysBack = (days: number) => new Date(midnight.getTime() - days * 86_400_000).toISOString();
  switch (range) {
    case 'today':
      return { created_after: midnight.toISOString() };
    case 'yesterday':
      return { created_after: daysBack(1), created_before: midnight.toISOString() };
    case 'last_7_days':
      return { created_after: daysBack(7) };
    case 'last_30_days':
      return { created_after: daysBack(30) };
    case 'last_90_days':
      return { created_after: daysBack(90) };
  }
}

/** Fathom sends "HH:MM:SS" transcript timestamps. */
export function timestampToSeconds(timestamp: string): number | null {
  const parts = timestamp.split(':').map(Number);
  if (parts.length > 3 || parts.some(Number.isNaN)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function formatSeconds(seconds: number): string {
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function deepLink(url: string, seconds: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}timestamp=${Math.floor(seconds)}`;
}

/** One line per entry: "[MM:SS] Speaker: text", with a Markdown link into the recording when `url` is given. */
export function formatTranscriptLine(entry: TranscriptEntry, url?: string): string {
  const seconds = timestampToSeconds(entry.timestamp);
  const label = seconds === null ? entry.timestamp : formatSeconds(seconds);
  const stamp = url && seconds !== null ? `[${label}](${deepLink(url, seconds)})` : `[${label}]`;
  return `${stamp} ${entry.speaker.display_name}: ${entry.text}`;
}

export interface FormatOptions {
  detailed?: boolean;
  include_summary?: boolean;
  include_action_items?: boolean;
  include_highlights?: boolean;
  include_crm_matches?: boolean;
  summary_max_chars?: number;
}

function durationMinutes(meeting: Meeting): number | null {
  const ms = Date.parse(meeting.recording_end_time) - Date.parse(meeting.recording_start_time);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 60_000) : null;
}

export function formatMeeting(meeting: Meeting, options: FormatOptions = {}): Record<string, unknown> {
  const url = meeting.share_url || meeting.url;
  const out: Record<string, unknown> = {
    recording_id: meeting.recording_id,
    title: meeting.title || meeting.meeting_title,
    date: meeting.scheduled_start_time || meeting.created_at,
    duration_minutes: durationMinutes(meeting),
    url
  };
  if (meeting.meeting_type) out.meeting_type = meeting.meeting_type;

  if (options.detailed) {
    if (meeting.meeting_title && meeting.meeting_title !== meeting.title) out.calendar_title = meeting.meeting_title;
    out.attendees = (meeting.calendar_invitees ?? []).map(i => ({ name: i.name, email: i.email, external: i.is_external }));
    out.recorded_by = { name: meeting.recorded_by?.name, email: meeting.recorded_by?.email, team: meeting.recorded_by?.team };
    out.has_external_invitees = meeting.calendar_invitees_domains_type === 'one_or_more_external';
    out.language = meeting.transcript_language;
    if (meeting.shared_with) out.shared_with = meeting.shared_with;
    if (meeting.meeting_url) out.join_url = meeting.meeting_url;
  } else {
    out.attendees = (meeting.calendar_invitees ?? []).map(i => i.name || i.email).filter(Boolean);
  }

  if (options.include_summary) {
    let summary = meeting.default_summary?.markdown_formatted ?? null;
    if (summary && options.summary_max_chars && summary.length > options.summary_max_chars) {
      summary = `${summary.slice(0, options.summary_max_chars)}... [truncated, full text via get_meeting_summary]`;
    }
    out.summary = summary;
  }
  if (options.include_action_items) {
    out.action_items = (meeting.action_items ?? []).map(item => ({
      description: item.description,
      completed: item.completed,
      assignee: item.assignee?.name || item.assignee?.email || null,
      at: item.recording_timestamp,
      ...(options.detailed ? { link: item.recording_playback_url } : {})
    }));
  }
  if (options.include_highlights) {
    out.highlights = (meeting.highlights ?? []).map(h => ({
      type: h.type,
      summary: h.summary,
      ...(h.text ? { text: h.text } : {}),
      at: formatSeconds(h.start_time),
      link: deepLink(url, h.start_time)
    }));
  }
  if (options.include_crm_matches && meeting.crm_matches) {
    const { contacts, companies, deals, error } = meeting.crm_matches;
    out.crm_matches = error ? { error } : { contacts, companies, deals };
  }
  return out;
}

export const SEARCH_FIELDS = ['title', 'summary', 'action_items', 'highlights', 'transcript'] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

function fieldText(meeting: Meeting, field: SearchField): string {
  switch (field) {
    case 'title':
      return `${meeting.title ?? ''} ${meeting.meeting_title ?? ''}`;
    case 'summary':
      return meeting.default_summary?.markdown_formatted ?? '';
    case 'action_items':
      return (meeting.action_items ?? []).map(i => i.description).join('\n');
    case 'highlights':
      return (meeting.highlights ?? []).map(h => `${h.summary ?? ''} ${h.text ?? ''}`).join('\n');
    case 'transcript':
      return (meeting.transcript ?? []).map(e => e.text).join('\n');
  }
}

export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * A meeting matches when every query word appears somewhere across the searched fields.
 * Returns the fields containing at least one word, or null for no match.
 */
export function matchMeeting(meeting: Meeting, words: string[], fields: readonly SearchField[]): SearchField[] | null {
  const texts = fields.map(field => [field, fieldText(meeting, field).toLowerCase()] as const);
  if (!words.every(word => texts.some(([, text]) => text.includes(word)))) return null;
  return texts.filter(([, text]) => words.some(word => text.includes(word))).map(([field]) => field);
}

/** Transcript lines containing the most query words, best first. */
export function transcriptSnippets(meeting: Meeting, words: string[], max = 3): string[] {
  const url = meeting.share_url || meeting.url;
  return (meeting.transcript ?? [])
    .map(entry => ({ entry, hits: words.filter(word => entry.text.toLowerCase().includes(word)).length }))
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, max)
    .map(({ entry }) => formatTranscriptLine(entry, url));
}

export function matchesAttendee(meeting: Meeting, attendee: string): boolean {
  const needle = attendee.toLowerCase();
  return (meeting.calendar_invitees ?? []).some(
    i =>
      i.email?.toLowerCase().includes(needle) ||
      i.name?.toLowerCase().includes(needle) ||
      i.matched_speaker_display_name?.toLowerCase().includes(needle)
  );
}
