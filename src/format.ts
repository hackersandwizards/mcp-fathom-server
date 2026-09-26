import type { CalendarInvitee, Meeting, TranscriptEntry } from './fathom.js';

export const DATE_RANGES = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days'] as const;
export type DateRange = (typeof DATE_RANGES)[number];

/** Day boundaries use the local time zone of the machine running the server. */
export function dateRangeBounds(range: DateRange, now = new Date()): { created_after: string; created_before?: string } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysBack = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).toISOString();
  switch (range) {
    case 'today':
      return { created_after: midnight.toISOString() };
    case 'yesterday':
      return { created_after: daysBack(1), created_before: midnight.toISOString() };
    // "Last 7 days" counts today, so it starts 6 days back.
    case 'last_7_days':
      return { created_after: daysBack(6) };
    case 'last_30_days':
      return { created_after: daysBack(29) };
    case 'last_90_days':
      return { created_after: daysBack(89) };
  }
}

/** Fathom sends "HH:MM:SS" transcript timestamps. */
export function timestampToSeconds(timestamp: string): number | null {
  if (!timestamp?.trim()) return null;
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

export const meetingUrl = (meeting: Meeting) => meeting.share_url || meeting.url;
export const meetingDate = (meeting: Meeting) => meeting.scheduled_start_time || meeting.created_at;

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
  const url = meetingUrl(meeting);
  const out: Record<string, unknown> = {
    recording_id: meeting.recording_id,
    title: meeting.title || meeting.meeting_title,
    date: meetingDate(meeting),
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
  const url = meetingUrl(meeting);
  return (meeting.transcript ?? [])
    .map(entry => ({ entry, hits: words.filter(word => entry.text.toLowerCase().includes(word)).length }))
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, max)
    .map(({ entry }) => formatTranscriptLine(entry, url));
}

/** `needle` is lowercase. */
export function anyIncludes(values: Array<string | null | undefined>, needle: string): boolean {
  return values.some(value => value?.toLowerCase().includes(needle));
}

export function inviteeMatches(invitee: CalendarInvitee, needle: string): boolean {
  return anyIncludes([invitee.name, invitee.email, invitee.matched_speaker_display_name], needle);
}

export interface Person {
  name: string | null;
  email: string | null;
  external: boolean | null;
  spoke: boolean;
  /** Other names Fathom shows for this person, such as the speaker name matched to an invitee. */
  aliases?: string[];
}

/** The /calls/<id> or /share/... path of a fathom.video URL, or null. */
export function linkPath(value: string | null | undefined): string | null {
  try {
    const raw = value ?? '';
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : raw.startsWith('/') ? `https://fathom.video${raw}` : `https://${raw}`);
    if (!/(^|\.)fathom\.video$/.test(url.hostname)) return null;
    const path = url.pathname.replace(/\/+$/, '');
    return /^\/(calls|share)\//.test(path) ? path : null;
  } catch {
    return null;
  }
}

/** Speakers (from the transcript) and invitees of one meeting, one entry per person. */
export function peopleOf(meeting: Meeting): Person[] {
  const people = new Map<string, Person>();
  // Fathom links a speaker to an invitee by display name; unmatched speakers carry no email.
  const inviteeBySpeaker = new Map<string, string>();
  const add = (key: string, name: string | null, email: string | null, patch: Partial<Person>) => {
    const person = people.get(key) ?? { name, email, external: null, spoke: false };
    // Fathom sometimes shows an invitee's email as their name; a real name seen later wins.
    const better = !person.name || (person.name.includes('@') && !!name && !name.includes('@'));
    const merged = { ...person, name: better ? name : person.name, email: person.email || email, ...patch };
    for (const alias of [name, person.name]) {
      if (alias && alias !== merged.name && !merged.aliases?.includes(alias)) merged.aliases = [...(merged.aliases ?? []), alias];
    }
    people.set(key, merged);
  };
  for (const invitee of meeting.calendar_invitees ?? []) {
    const key = (invitee.email || invitee.name || invitee.matched_speaker_display_name || '').toLowerCase();
    if (!key) continue;
    add(key, invitee.name || invitee.matched_speaker_display_name, invitee.email, { external: invitee.is_external });
    if (invitee.matched_speaker_display_name) add(key, invitee.matched_speaker_display_name, null, {});
    for (const alias of [invitee.matched_speaker_display_name, invitee.name]) if (alias) inviteeBySpeaker.set(alias.toLowerCase(), key);
  }
  // One entry per distinct speaker, not per transcript line.
  const speakers = new Map((meeting.transcript ?? []).filter(e => e.speaker).map(({ speaker }) => [`${speaker.display_name}|${speaker.matched_calendar_invitee_email}`, speaker]));
  for (const speaker of speakers.values()) {
    const byName = speaker.display_name?.toLowerCase();
    const key = speaker.matched_calendar_invitee_email?.toLowerCase() || (byName && inviteeBySpeaker.get(byName)) || byName;
    if (key) add(key, speaker.display_name, speaker.matched_calendar_invitee_email, { spoke: true });
  }
  return [...people.values()];
}
