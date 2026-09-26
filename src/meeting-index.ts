import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FathomClient, Meeting } from './fathom.js';

// Backfill reads one page of 10 transcripts, then pauses, so it uses about half of Fathom's
// transcript budget (30 per minute) and leaves the rest for interactive tool calls.
const BACKFILL_PAUSE_MS = 4_000;
const ERROR_PAUSE_MS = 60_000;

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
  meetings: Record<string, IndexedMeeting>;
}

export function defaultIndexPath(apiKey: string): string {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const keyId = createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
  return join(cache, 'mcp-fathom-server', `index-${keyId}.json`);
}

/** Speakers (from the transcript) and invitees of one meeting, one entry per person. */
export function peopleOf(meeting: Meeting): IndexedPerson[] {
  const people = new Map<string, IndexedPerson>();
  const add = (name: string | null, email: string | null, patch: Partial<IndexedPerson>) => {
    const key = (email || name || '').toLowerCase();
    if (!key) return;
    const person = people.get(key) ?? { name, email, external: null, invited: false, spoke: false };
    people.set(key, { ...person, name: person.name || name, ...patch });
  };
  for (const invitee of meeting.calendar_invitees ?? []) {
    add(invitee.name || invitee.matched_speaker_display_name, invitee.email, { external: invitee.is_external, invited: true });
  }
  for (const entry of meeting.transcript ?? []) {
    add(entry.speaker.display_name, entry.speaker.matched_calendar_invitee_email, { spoke: true });
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
 */
export class MeetingIndex {
  private state: State = { version: 1, newest_created_at: null, backfill_cursor: null, complete: false, meetings: {} };
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly client: FathomClient,
    private readonly path: string,
    private readonly sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms).unref())
  ) {}

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8')) as State;
      if (saved.version === 1) this.state = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[index] Could not read ${this.path}, rebuilding: ${(error as Error).message}`);
    }
  }

  /** Runs index work one step at a time, so the backfill and a refresh never interleave. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private add(meetings: Meeting[]): void {
    for (const m of meetings) {
      this.state.meetings[m.recording_id] = toIndexed(m);
      if (!this.state.newest_created_at || m.created_at > this.state.newest_created_at) this.state.newest_created_at = m.created_at;
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, this.path);
  }

  /** Walks the history backwards, one page at a time, until every meeting is indexed. */
  async backfill(): Promise<void> {
    while (!this.state.complete && !this.stopped) {
      try {
        await this.serial(async () => {
          const page = await this.client.listMeetings({ include_transcript: true }, 10, this.state.backfill_cursor ?? undefined);
          this.add(page.items);
          if (page.error) throw new Error(page.error);
          this.state.backfill_cursor = page.next_cursor;
          this.state.complete = !page.next_cursor;
          await this.save();
        });
        await this.sleep(BACKFILL_PAUSE_MS);
      } catch (error) {
        const message = (error as Error).message;
        console.error(`[index] Backfill paused: ${message}`);
        if (/API key/.test(message)) return;
        await this.sleep(ERROR_PAUSE_MS);
      }
    }
    if (this.state.complete) console.error(`[index] Complete: ${this.size} meetings`);
  }

  /** Adds meetings created since the newest indexed one. Usually one request. */
  refresh(): Promise<void> {
    return this.serial(async () => {
      if (!this.state.newest_created_at) return;
      const page = await this.client.listMeetings({ created_after: this.state.newest_created_at, include_transcript: true }, 200);
      if (!page.items.length) return;
      this.add(page.items);
      await this.save();
    });
  }

  stop(): void {
    this.stopped = true;
  }

  get size(): number {
    return Object.keys(this.state.meetings).length;
  }

  /** Newest first. */
  meetings(): IndexedMeeting[] {
    return Object.values(this.state.meetings).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  coverage() {
    const all = this.meetings();
    return {
      indexed_meetings: all.length,
      complete: this.state.complete,
      oldest_indexed: all.at(-1)?.created_at ?? null
    };
  }
}
