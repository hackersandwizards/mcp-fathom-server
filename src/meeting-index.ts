import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { link, mkdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FathomApiError, type FathomClient, type Meeting } from './fathom.js';
import { meetingDate } from './format.js';

// Backfill reads one page of 10 transcripts, then pauses, so it uses about half of Fathom's
// transcript budget (30 per minute) and leaves the rest for interactive tool calls.
const BACKFILL_PAUSE_MS = 4_000;
const ERROR_PAUSE_MS = 60_000;
const IDLE_MS = 60_000;
const LOCK_RETRY_MS = 5 * 60_000;
// The writer touches the lock at least every few minutes. An older lock is stale even when its pid
// runs, since after a reboot that pid can belong to an unrelated process.
const LOCK_STALE_MS = 15 * 60_000;
// A tool call skips its sync when the index was synced this recently, unless it missed.
const FRESH_MS = 60_000;
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
  /** The transcript could not be read, so the next walk tries again. */
  speakers_missing?: true;
}

interface State {
  version: 2;
  newest_created_at: string | null;
  backfill_cursor: string | null;
  /** At least one walk reached the oldest meeting. */
  complete: boolean;
  /** A walk is under way. A re-walk keeps the index complete while it runs. */
  walking?: boolean;
  /** The last walk would have deleted more than half the index, so this walk checks it. */
  confirming_sweep?: boolean;
  completed_at?: string;
  walk?: number;
  forward_synced_at?: string;
  meetings: Record<string, IndexedMeeting>;
}

const emptyState = (): State => ({ version: 2, newest_created_at: null, backfill_cursor: null, complete: false, meetings: {} });

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
    add(key, invitee.name || invitee.matched_speaker_display_name, invitee.email, { external: invitee.is_external, invited: true });
    if (invitee.matched_speaker_display_name) add(key, invitee.matched_speaker_display_name, null, {});
    for (const alias of [invitee.matched_speaker_display_name, invitee.name]) if (alias) inviteeBySpeaker.set(alias.toLowerCase(), key);
  }
  for (const { speaker } of meeting.transcript ?? []) {
    if (!speaker) continue;
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
    date: meetingDate(m),
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
  private stopped = false;
  private writer = false;
  private loadedMtime = 0;
  private pagesSinceSave = 0;
  private freshAt = 0;
  private missAt = 0;
  private cursorRejections = 0;
  private exitHooked = false;
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

  /** Reads the file when it changed. The writer owns the file and never reloads it. */
  async load(): Promise<void> {
    if (this.writer) return;
    try {
      const { mtimeMs } = await stat(this.path);
      if (mtimeMs === this.loadedMtime) return;
      // An unreadable or older file is read again only once it changes.
      this.loadedMtime = mtimeMs;
      const saved = JSON.parse(await readFile(this.path, 'utf8')) as State;
      // An older format is rebuilt from scratch rather than migrated.
      if (saved.version === 2) {
        this.state = saved;
        this.sorted = this.byLink = null;
        this.freshAt = 0;
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
          // A process that was writer before may hold a stale copy of what a later writer saved.
          await this.load();
          return this.own();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const pid = Number(await readFile(this.lockPath, 'utf8').catch(() => ''));
          if (pid === process.pid) return this.own();
          const age = Date.now() - ((await stat(this.lockPath).catch(() => null))?.mtimeMs ?? 0);
          if (isAlive(pid) && age < LOCK_STALE_MS) return false;
          await unlink(this.lockPath).catch(() => {});
        }
      }
      return false;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  private own(): true {
    if (!this.exitHooked) {
      process.once('exit', () => this.releaseLock());
      // Keeps the lock fresh during long steps too, such as a catch-up sync after days offline.
      setInterval(() => void this.heartbeat(), LOCK_STALE_MS / 3).unref();
      this.exitHooked = true;
    }
    return (this.writer = true);
  }

  private releaseLock(): void {
    try {
      if (readFileSync(this.lockPath, 'utf8') === String(process.pid)) unlinkSync(this.lockPath);
    } catch {}
  }

  /** Touches the lock, or stops writing when another process took it over as stale. */
  private async heartbeat(): Promise<void> {
    if (!this.writer) return;
    if ((await readFile(this.lockPath, 'utf8').catch(() => '')) !== String(process.pid)) {
      this.writer = false;
      return;
    }
    const now = new Date();
    await utimes(this.lockPath, now, now).catch(() => {});
  }

  /** Runs index work one step at a time, so the loop and a tool call never interleave. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * A meeting listed without its transcript keeps the speakers found earlier. A new one is marked,
   * so a later listing with transcripts reads its speakers.
   */
  private add(meetings: Meeting[]): void {
    const walk = this.state.walk ?? 0;
    for (const m of meetings) {
      const indexed: IndexedMeeting = { ...toIndexed(m), walk };
      const known = this.state.meetings[m.recording_id];
      if (!m.transcript) {
        if (known) indexed.people = known.people;
        if (!known || known.speakers_missing) indexed.speakers_missing = true;
      }
      this.state.meetings[m.recording_id] = indexed;
    }
    if (meetings.length) this.sorted = this.byLink = null;
  }

  private async save(): Promise<void> {
    await this.heartbeat();
    if (!this.writer) return;
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
    this.state.walking = true;
    this.state.backfill_cursor = null;
    this.state.walk = (this.state.walk ?? 0) + 1;
  }

  /** Reads one page of the history walk, newest to oldest. */
  private async walkPage(): Promise<void> {
    await this.heartbeat();
    if (!this.writer) return;
    const cursor = this.state.backfill_cursor ?? undefined;
    // A re-walk only learns which meetings exist. It re-reads a page with transcripts only when the
    // page holds a new meeting or one whose speakers are missing, like one page of the first build.
    // A restarted first walk re-reads pages it already holds cheaply as well.
    const rewalk = this.state.complete || (this.state.walk ?? 0) > 0;
    const page = await this.client.listMeetings({ include_transcript: !rewalk }, 10, cursor);
    this.add(page.items);
    if (rewalk && page.items.some(m => this.state.meetings[m.recording_id]?.speakers_missing)) {
      const full = await this.client.listMeetings({ include_transcript: true }, 10, cursor).catch(() => null);
      if (full) this.add(full.items);
    }
    if (!cursor && page.items[0]) this.raiseWatermark(page.items[0].created_at);
    this.state.backfill_cursor = page.next_cursor;
    if (!page.next_cursor) {
      const walk = this.state.walk ?? 0;
      const stale = Object.entries(this.state.meetings).filter(([, m]) => (m.walk ?? 0) < walk);
      // A walk that ends early, as after an expired cursor, would delete most of the index. Such a
      // sweep waits for one more walk from the top to agree.
      if (stale.length > this.size / 2 && !this.state.confirming_sweep) {
        this.state.confirming_sweep = true;
        this.startWalk();
        return this.save();
      }
      this.state.confirming_sweep = false;
      // Every visible meeting was seen during this walk; the rest were deleted or unshared.
      for (const [id] of stale) delete this.state.meetings[id];
      this.sorted = this.byLink = null;
      this.state.walking = false;
      this.state.complete = true;
      this.state.completed_at = new Date().toISOString();
    }
    if (!page.next_cursor || ++this.pagesSinceSave >= SAVE_EVERY_PAGES) await this.save();
  }

  /**
   * Adds meetings created since the newest indexed one, re-reading `overlapMs` before it for
   * meetings that finished processing late. Only the background sync records its time, and a tool
   * call saves only what it adds. The watermark moves only after every page arrived, so a
   * cut-short sync leaves no gap.
   */
  private async forward(deadline: number, overlapMs: number, background: boolean): Promise<void> {
    const newest = this.state.newest_created_at;
    // An empty index is current only once a completed walk found no meetings at all.
    if (!newest && !this.state.complete) return;
    const since = newest && new Date(Date.parse(newest) - overlapMs).toISOString();
    // The listing without transcripts is cheap. Transcripts are read only for new meetings and
    // meetings whose speakers are missing, such as ones still processing at the last sync.
    const list = (include_transcript: boolean) =>
      this.client.listMeetings({ created_after: since || undefined, include_transcript }, Infinity, undefined, () => Date.now() > deadline);
    const missing = () => new Set(Object.values(this.state.meetings).filter(m => m.speakers_missing).map(m => m.recording_id));
    const before = { size: Object.keys(this.state.meetings).length, missing: missing() };
    let page = await list(false);
    this.add(page.items);
    if (!page.error && !page.next_cursor && page.items.some(m => this.state.meetings[m.recording_id].speakers_missing)) {
      page = await list(true);
      this.add(page.items);
    }
    const after = missing();
    const changed = Object.keys(this.state.meetings).length !== before.size || [...before.missing].some(id => !after.has(id));
    if (page.error || page.next_cursor) {
      await this.save();
      throw new FathomApiError(page.error ?? 'Stopped at the time limit.', page.status);
    }
    for (const m of page.items) this.raiseWatermark(m.created_at);
    this.freshAt = Date.now();
    // Only the writer's loop reads this time, so it is saved with the next change rather than alone.
    if (background) this.state.forward_synced_at = new Date().toISOString();
    if (changed) await this.save();
  }

  private handleLoopError(error: unknown): 'stop' | 'continue' {
    const message = (error as Error).message;
    const status = error instanceof FathomApiError ? error.status : undefined;
    // Only API errors can heal by waiting. A file system error, such as an unwritable cache
    // directory, or a bug would fail the same way every minute.
    if (status === 401 || !(error instanceof FathomApiError)) {
      console.error(`[index] Stopped: ${message}`);
      return 'stop';
    }
    console.error(`[index] Paused: ${message}`);
    return 'continue';
  }

  /** Walks the history until every meeting is indexed. Writer only. False means stop for good. */
  async backfill(): Promise<boolean> {
    while (this.writer && (!this.state.complete || this.state.walking) && !this.stopped) {
      try {
        await this.serial(() => this.walkPage());
        this.cursorRejections = 0;
        await this.sleep(BACKFILL_PAUSE_MS);
      } catch (error) {
        // Keep the pages read since the last save, so a restart resumes from here.
        await this.serial(() => this.save()).catch(() => {});
        // A saved cursor Fathom or this server keeps rejecting: walk again from the newest meeting.
        const badCursor = (error as FathomApiError).status === 400 || /Invalid cursor/.test((error as Error).message);
        if (badCursor && this.state.backfill_cursor && ++this.cursorRejections >= 3) {
          this.cursorRejections = 0;
          this.startWalk();
        }
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
        await this.heartbeat();
        if (!this.writer && !(await this.lock())) {
          await this.sleep(LOCK_RETRY_MS);
          await this.load();
          continue;
        }
        if (this.state.complete && !this.state.walking && age(this.state.completed_at) > REWALK_AFTER_MS) this.startWalk();
        if (!this.state.complete || this.state.walking) {
          if (!(await this.backfill())) return this.resign();
          if (!this.state.complete || this.state.walking) continue;
          console.error(`[index] Complete: ${this.size} meetings`);
        }
        if (age(this.state.forward_synced_at) > FORWARD_EVERY_MS) await this.serial(() => this.forward(Infinity, REFRESH_OVERLAP_MS, true));
        await this.sleep(IDLE_MS);
      } catch (error) {
        if (this.handleLoopError(error) === 'stop') return this.resign();
        await this.sleep(ERROR_PAUSE_MS);
      }
    }
  }

  /** Gives the lock up when the loop stops for good, so another session can maintain the index. */
  private resign(): void {
    this.writer = false;
    this.releaseLock();
  }

  /**
   * Brings the index as close to current as one tool call allows. A process that does not hold the
   * lock reloads the file and adds newer meetings in memory only. After a lookup missed, the sync
   * runs even if one just ran, and re-reads a day for late meetings, at most once a minute.
   * Returns a warning when the newest meetings may be missing.
   */
  async freshen(deadline: number, afterMiss = false): Promise<string | undefined> {
    if (!this.writer) await this.load();
    const overlap = afterMiss && Date.now() - this.missAt >= FRESH_MS;
    if (!overlap && Date.now() - this.freshAt < FRESH_MS) return undefined;
    if (overlap) this.missAt = Date.now();
    // Waits for the index step in progress, usually one page, unless the time limit passes first.
    const busy = 'the index was busy until the time limit.';
    const sync = this.serial(async () => {
      if (Date.now() > deadline) throw new FathomApiError(busy);
      await this.forward(deadline, overlap ? REFRESH_OVERLAP_MS : 0, false);
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      if (Number.isFinite(deadline)) timer = setTimeout(() => reject(new FathomApiError(busy)), Math.max(0, deadline - Date.now())).unref();
    });
    return Promise.race([sync, timeout]).finally(() => clearTimeout(timer)).then(
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
