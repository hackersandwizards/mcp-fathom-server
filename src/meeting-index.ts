import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FathomApiError, type FathomClient, type Meeting } from './fathom.js';

// Backfill reads one page of 10 transcripts, then pauses, so it uses about half of Fathom's
// transcript budget (30 per minute) and leaves the rest for interactive tool calls.
const BACKFILL_PAUSE_MS = 4_000;
const ERROR_PAUSE_MS = 60_000;
const IDLE_MS = 60_000;
const LOCK_RETRY_MS = 5 * 60_000;
const SAVE_EVERY_PAGES = 10;
// The background loop fetches new meetings this often, without a time limit, so gaps close.
const FORWARD_EVERY_MS = 10 * 60_000;
// Forward syncs re-read this far behind the newest indexed meeting, so transcripts that were still
// processing when a meeting was first indexed fill in.
const REFRESH_OVERLAP_MS = 24 * 3_600_000;
// A complete index is walked again after this, to add meetings shared later and drop deleted ones.
const REWALK_AFTER_MS = 7 * 24 * 3_600_000;

export interface IndexedPerson {
  name: string | null;
  email: string | null;
  external: boolean | null;
  invited: boolean;
  spoke: boolean;
  /** Other names Fathom shows for this person, such as the speaker name matched to an invitee. */
  aliases?: string[];
}

export interface IndexedMeeting {
  recording_id: number;
  title: string;
  date: string;
  created_at: string;
  url: string;
  share_url: string;
  people: IndexedPerson[];
  /** The history walk that last saw this meeting. */
  walk?: number;
}

interface State {
  version: 1;
  newest_created_at: string | null;
  backfill_cursor: string | null;
  complete: boolean;
  completed_at?: string;
  walk?: number;
  forward_synced_at?: string;
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
    const merged = { ...person, name: person.name || name, email: person.email || email, ...patch };
    if (name && merged.name !== name && !merged.aliases?.includes(name)) merged.aliases = [...(merged.aliases ?? []), name];
    people.set(key, merged);
  };
  for (const invitee of meeting.calendar_invitees ?? []) {
    const key = (invitee.email || invitee.name || invitee.matched_speaker_display_name || '').toLowerCase();
    if (!key) continue;
    add(key, invitee.name || invitee.matched_speaker_display_name, invitee.email, { external: invitee.is_external, invited: true });
    if (invitee.matched_speaker_display_name) add(key, invitee.matched_speaker_display_name, null, {});
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
 * One process per API key holds the lock file, runs the background loop and writes the file.
 * Other server processes read the file when it changes, so they neither double the API load nor
 * overwrite each other, and they take the lock over when the writer exits.
 */
export class MeetingIndex {
  private state = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private stopped = false;
  private writer = false;
  private loadedMtime = 0;
  private pagesSinceSave = 0;
  private sorted: IndexedMeeting[] | null = null;
  private byLink: Map<string, IndexedMeeting> | null = null;

  constructor(
    private readonly client: FathomClient,
    private readonly path: string,
    private readonly sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms).unref())
  ) {}

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  async load(): Promise<void> {
    try {
      const { mtimeMs } = await stat(this.path);
      if (mtimeMs === this.loadedMtime) return;
      const saved = JSON.parse(await readFile(this.path, 'utf8')) as State;
      if (saved.version === 1) {
        this.state = saved;
        this.loadedMtime = mtimeMs;
        this.sorted = this.byLink = null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[index] Could not read ${this.path}: ${(error as Error).message}`);
    }
  }

  /** Takes the lock file, or returns false when a live process holds it. */
  async lock(): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // The pid goes into a temp file first and is hard-linked into place, which is atomic:
    // no other process can ever read a half-written lock.
    const temp = `${this.lockPath}.${process.pid}`;
    await writeFile(temp, String(process.pid), { mode: 0o600 });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await link(temp, this.lockPath);
          if (!attempt) process.once('exit', () => this.releaseLock());
          return (this.writer = true);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const pid = Number(await readFile(this.lockPath, 'utf8').catch(() => ''));
          if (pid === process.pid) return (this.writer = true);
          if (isAlive(pid)) return false;
          await unlink(this.lockPath).catch(() => {});
        }
      }
      return false;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  private releaseLock(): void {
    try {
      if (readFileSync(this.lockPath, 'utf8') === String(process.pid)) unlinkSync(this.lockPath);
    } catch {}
  }

  /** Runs index work one step at a time, so the loop and a tool call never interleave. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.busy++;
      try {
        return await work();
      } finally {
        this.busy--;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private add(meetings: Meeting[]): void {
    const walk = this.state.walk ?? 0;
    for (const m of meetings) this.state.meetings[m.recording_id] = { ...toIndexed(m), walk };
    if (meetings.length) this.sorted = this.byLink = null;
  }

  private async save(): Promise<void> {
    if (!this.writer) return;
    // Another process that took over a lock it wrongly saw as stale owns the file now.
    if ((await readFile(this.lockPath, 'utf8').catch(() => '')) !== String(process.pid)) {
      this.writer = false;
      return;
    }
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, this.path);
    this.loadedMtime = (await stat(this.path)).mtimeMs;
    this.pagesSinceSave = 0;
  }

  private raiseWatermark(createdAt: string): void {
    if (!this.state.newest_created_at || createdAt > this.state.newest_created_at) this.state.newest_created_at = createdAt;
  }

  private startWalk(): void {
    this.state.complete = false;
    this.state.backfill_cursor = null;
    this.state.walk = (this.state.walk ?? 0) + 1;
  }

  /** Reads one page of the history walk, newest to oldest. */
  private async walkPage(): Promise<void> {
    const page = await this.client.listMeetings({ include_transcript: true }, 10, this.state.backfill_cursor ?? undefined);
    this.add(page.items);
    if (!this.state.backfill_cursor && page.items[0]) this.raiseWatermark(page.items[0].created_at);
    this.state.backfill_cursor = page.next_cursor;
    if (!page.next_cursor) {
      // Every visible meeting was seen during this walk; the rest were deleted or unshared.
      const walk = this.state.walk ?? 0;
      for (const [id, m] of Object.entries(this.state.meetings)) if ((m.walk ?? 0) < walk) delete this.state.meetings[id];
      this.sorted = this.byLink = null;
      this.state.complete = true;
      this.state.completed_at = new Date().toISOString();
    }
    if (this.state.complete || ++this.pagesSinceSave >= SAVE_EVERY_PAGES) await this.save();
  }

  /**
   * Adds meetings created since the newest indexed one, re-reading a day of overlap.
   * The watermark moves only after every page arrived, so a cut-short sync leaves no gap.
   */
  private async forward(deadline: number): Promise<void> {
    const newest = this.state.newest_created_at;
    if (!newest) return;
    const since = new Date(Date.parse(newest) - REFRESH_OVERLAP_MS).toISOString();
    const page = await this.client.listMeetings({ created_after: since, include_transcript: true }, Infinity, undefined, () => Date.now() > deadline);
    this.add(page.items);
    if (page.error || page.next_cursor) {
      await this.save();
      throw new FathomApiError(page.error ?? 'Stopped at the time limit.');
    }
    for (const m of page.items) this.raiseWatermark(m.created_at);
    this.state.forward_synced_at = new Date().toISOString();
    await this.save();
  }

  private handleLoopError(error: unknown): 'stop' | 'continue' {
    const message = (error as Error).message;
    const status = error instanceof FathomApiError ? error.status : undefined;
    console.error(`[index] Paused: ${message}`);
    if (status === 401) return 'stop';
    // A saved cursor Fathom or this server no longer accepts: walk again from the newest meeting.
    if (status === 400 || /Invalid cursor/.test(message)) this.startWalk();
    return 'continue';
  }

  /** Walks the history until every meeting is indexed. Writer only. False means stop for good. */
  async backfill(): Promise<boolean> {
    while (this.writer && !this.state.complete && !this.stopped) {
      try {
        await this.serial(() => this.walkPage());
        await this.sleep(BACKFILL_PAUSE_MS);
      } catch (error) {
        // Keep the pages read since the last save, so a restart resumes from here.
        await this.save().catch(() => {});
        if (this.handleLoopError(error) === 'stop') return false;
        await this.sleep(ERROR_PAUSE_MS);
      }
    }
    return true;
  }

  /** The background loop: take the lock, build the index, then keep it current. */
  async run(): Promise<void> {
    const age = (iso?: string) => (iso ? Date.now() - Date.parse(iso) : Infinity);
    while (!this.stopped) {
      try {
        if (!this.writer && !(await this.lock())) {
          await this.sleep(LOCK_RETRY_MS);
          await this.load();
          continue;
        }
        if (this.state.complete && age(this.state.completed_at) > REWALK_AFTER_MS) this.startWalk();
        if (!this.state.complete) {
          if (!(await this.backfill())) return;
          if (!this.state.complete) continue;
          console.error(`[index] Complete: ${this.size} meetings`);
        }
        if (age(this.state.forward_synced_at) > FORWARD_EVERY_MS) await this.serial(() => this.forward(Infinity));
        await this.sleep(IDLE_MS);
      } catch (error) {
        if (this.handleLoopError(error) === 'stop') return;
        await this.sleep(ERROR_PAUSE_MS);
      }
    }
  }

  /**
   * Brings the index as close to current as one tool call allows. Returns a warning when the
   * newest meetings may be missing: the loop is busy, the sync failed, or this process only reads.
   */
  async freshen(deadline: number): Promise<string | undefined> {
    if (!this.writer) {
      await this.load();
      return 'Another server process maintains the index, so meetings from the last minutes may be missing.';
    }
    if (this.busy) return 'The index is being updated, so meetings from the last minutes may be missing.';
    return this.serial(() => this.forward(deadline)).then(
      () => undefined,
      (error: Error) => `Newest meetings may be missing: ${error.message}`
    );
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
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
