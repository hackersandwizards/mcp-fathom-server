import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FathomApiError, type FathomClient, type Meeting } from './fathom.js';

// Backfill reads one page of 10 transcripts, then pauses, so it uses about half of Fathom's
// transcript budget (30 per minute) and leaves the rest for interactive tool calls.
const BACKFILL_PAUSE_MS = 4_000;
const ERROR_PAUSE_MS = 60_000;
// Refresh re-reads this far behind the newest indexed meeting, so transcripts that were still
// processing when a meeting was first indexed fill in.
const REFRESH_OVERLAP_MS = 24 * 3_600_000;
// A complete index is walked again after this, to pick up older meetings shared with the user later.
const REWALK_AFTER_MS = 7 * 24 * 3_600_000;

export interface IndexedPerson {
  name: string | null;
  email: string | null;
  external: boolean | null;
  invited: boolean;
  spoke: boolean;
}

export interface IndexedMeeting {
  recording_id: number;
  title: string;
  date: string;
  created_at: string;
  url: string;
  share_url: string;
  people: IndexedPerson[];
}

interface State {
  version: 1;
  newest_created_at: string | null;
  backfill_cursor: string | null;
  complete: boolean;
  completed_at?: string;
  meetings: Record<string, IndexedMeeting>;
}

const emptyState = (): State => ({ version: 1, newest_created_at: null, backfill_cursor: null, complete: false, meetings: {} });

export function defaultIndexPath(apiKey: string): string {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const keyId = createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
  return join(cache, 'mcp-fathom-server', `index-${keyId}.json`);
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
export function peopleOf(meeting: Meeting): IndexedPerson[] {
  const people = new Map<string, IndexedPerson>();
  // Fathom links a speaker to an invitee by display name; unmatched speakers carry no email.
  const inviteeBySpeaker = new Map<string, string>();
  const add = (key: string, name: string | null, email: string | null, patch: Partial<IndexedPerson>) => {
    const person = people.get(key) ?? { name, email, external: null, invited: false, spoke: false };
    people.set(key, { ...person, name: person.name || name, email: person.email || email, ...patch });
  };
  for (const invitee of meeting.calendar_invitees ?? []) {
    const key = (invitee.email || invitee.name || invitee.matched_speaker_display_name || '').toLowerCase();
    if (!key) continue;
    add(key, invitee.name || invitee.matched_speaker_display_name, invitee.email, { external: invitee.is_external, invited: true });
    for (const alias of [invitee.matched_speaker_display_name, invitee.name]) if (alias) inviteeBySpeaker.set(alias.toLowerCase(), key);
  }
  for (const { speaker } of meeting.transcript ?? []) {
    const byName = speaker.display_name?.toLowerCase();
    const key = speaker.matched_calendar_invitee_email?.toLowerCase() || (byName && inviteeBySpeaker.get(byName)) || byName;
    if (key) add(key, speaker.display_name, speaker.matched_calendar_invitee_email, { spoke: true });
  }
  return [...people.values()];
}

export function toIndexed(m: Meeting): IndexedMeeting {
  return {
    recording_id: m.recording_id,
    title: m.title || m.meeting_title || '',
    date: m.scheduled_start_time || m.created_at,
    created_at: m.created_at,
    url: m.url,
    share_url: m.share_url,
    people: peopleOf(m)
  };
}

/**
 * A local index of every meeting's links and people, so find_person and find_meeting_by_link
 * cover the whole history: the Fathom API has neither a speaker index nor a link lookup.
 *
 * Only the process holding the lock file writes the index and runs the backfill. Other server
 * processes for the same key read the file and refresh in memory, so they neither double the
 * API load nor overwrite each other.
 */
export class MeetingIndex {
  private state = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private writer = false;
  private sorted: IndexedMeeting[] | null = null;
  private byLink: Map<string, IndexedMeeting> | null = null;

  constructor(
    private readonly client: FathomClient,
    private readonly path: string,
    private readonly sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms).unref())
  ) {}

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8')) as State;
      if (saved.version === 1) {
        this.state = saved;
        this.sorted = this.byLink = null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[index] Could not read ${this.path}, rebuilding: ${(error as Error).message}`);
    }
  }

  /** Takes the lock file, or returns false when a live process holds it. */
  async lock(): Promise<boolean> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        process.once('exit', () => {
          try {
            unlinkSync(lockPath);
          } catch {}
        });
        return (this.writer = true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number(await readFile(lockPath, 'utf8').catch(() => ''));
        if (pid && pid !== process.pid && isAlive(pid)) return false;
        // Left behind by a process that died: take it over.
        try {
          unlinkSync(lockPath);
        } catch {}
      }
    }
    return false;
  }

  /** Runs index work one step at a time, so the backfill and a refresh never interleave. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private add(meetings: Meeting[]): void {
    for (const m of meetings) this.state.meetings[m.recording_id] = toIndexed(m);
    if (meetings.length) this.sorted = this.byLink = null;
  }

  private async save(): Promise<void> {
    if (!this.writer) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, this.path);
  }

  /** Walks the history backwards, one page at a time, until every meeting is indexed. Writer only. */
  async backfill(): Promise<void> {
    if (!this.writer) return;
    const completedAt = this.state.completed_at ? Date.parse(this.state.completed_at) : 0;
    if (this.state.complete && Date.now() - completedAt > REWALK_AFTER_MS) {
      this.state.complete = false;
      this.state.backfill_cursor = null;
    }
    while (!this.state.complete && !this.stopped) {
      try {
        await this.serial(async () => {
          const page = await this.client.listMeetings({ include_transcript: true }, 10, this.state.backfill_cursor ?? undefined);
          this.add(page.items);
          if (!this.state.backfill_cursor && page.items[0]) this.raiseWatermark(page.items[0].created_at);
          this.state.backfill_cursor = page.next_cursor;
          if (!page.next_cursor) {
            this.state.complete = true;
            this.state.completed_at = new Date().toISOString();
          }
          await this.save();
        });
        await this.sleep(BACKFILL_PAUSE_MS);
      } catch (error) {
        const status = error instanceof FathomApiError ? error.status : undefined;
        console.error(`[index] Backfill paused: ${(error as Error).message}`);
        if (status === 401) return;
        // A saved cursor Fathom no longer accepts: walk again from the newest meeting.
        if (status === 400) this.state.backfill_cursor = null;
        await this.sleep(ERROR_PAUSE_MS);
      }
    }
    if (this.state.complete) console.error(`[index] Complete: ${this.size} meetings`);
  }

  private raiseWatermark(createdAt: string): void {
    if (!this.state.newest_created_at || createdAt > this.state.newest_created_at) this.state.newest_created_at = createdAt;
  }

  /**
   * Adds meetings created since the newest indexed one, re-reading a day of overlap.
   * The watermark moves only after every page arrived, so a cut-short refresh leaves no gap.
   */
  refresh(deadline = Infinity): Promise<void> {
    return this.serial(async () => {
      if (!this.writer) await this.load();
      const newest = this.state.newest_created_at;
      if (!newest) return;
      const since = new Date(Date.parse(newest) - REFRESH_OVERLAP_MS).toISOString();
      const page = await this.client.listMeetings({ created_after: since, include_transcript: true }, Infinity, undefined, () => Date.now() > deadline);
      this.add(page.items);
      if (page.error || page.next_cursor) {
        await this.save();
        throw new FathomApiError(page.error ?? 'Refresh stopped at the time limit.');
      }
      for (const m of page.items) this.raiseWatermark(m.created_at);
      await this.save();
    });
  }

  stop(): void {
    this.stopped = true;
  }

  get size(): number {
    return this.meetings().length;
  }

  /** Newest first. */
  meetings(): IndexedMeeting[] {
    return (this.sorted ??= Object.values(this.state.meetings).sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }

  findByLink(path: string): IndexedMeeting | undefined {
    if (!this.byLink) {
      this.byLink = new Map();
      for (const m of this.meetings()) {
        for (const link of [m.url, m.share_url]) {
          const key = linkPath(link);
          if (key) this.byLink.set(key, m);
        }
      }
    }
    return this.byLink.get(path);
  }

  coverage() {
    const all = this.meetings();
    return { indexed_meetings: all.length, complete: this.state.complete, oldest_indexed: all.at(-1)?.created_at ?? null };
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
