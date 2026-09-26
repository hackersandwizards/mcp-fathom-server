import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { peopleOf, dateRangeBounds, formatMeeting, formatTranscriptLine, matchMeeting, timestampToSeconds, transcriptSnippets } from '../src/format.js';
import { meeting } from './helpers.js';

const entry = (timestamp: string, text: string) => ({ speaker: { display_name: 'Jane', matched_calendar_invitee_email: null }, text, timestamp });

describe('format', () => {
  it('parses HH:MM:SS timestamps', () => {
    assert.equal(timestampToSeconds('01:02:03'), 3723);
    assert.equal(timestampToSeconds('00:05:32'), 332);
    assert.equal(timestampToSeconds('x'), null);
    assert.equal(timestampToSeconds(''), null);
  });

  it('links transcript lines and keeps hours', () => {
    assert.equal(formatTranscriptLine(entry('00:05:32', 'Hi'), 'https://f.test/share/a'), '[05:32](https://f.test/share/a?timestamp=332) Jane: Hi');
    assert.equal(formatTranscriptLine(entry('01:00:01', 'Hi')), '[1:00:01] Jane: Hi');
  });

  it('computes yesterday in local time', () => {
    const now = new Date(2026, 8, 26, 15, 0);
    const { created_after, created_before } = dateRangeBounds('yesterday', now);
    assert.equal(created_after, new Date(2026, 8, 25).toISOString());
    assert.equal(created_before, new Date(2026, 8, 26).toISOString());
  });

  it('keeps local midnight across a DST change', () => {
    const { created_after } = dateRangeBounds('last_7_days', new Date(2026, 2, 30, 12));
    const after = new Date(created_after);
    assert.equal(after.getHours(), 0);
    assert.equal(after.getDate(), 24);
  });

  it('prefers the public share URL and lists attendee names in concise mode', () => {
    const m = meeting(1, { calendar_invitees: [{ name: 'Ann', email: 'a@x.com', email_domain: 'x.com', is_external: true, matched_speaker_display_name: null }] });
    const out = formatMeeting(m);
    assert.equal(out.url, 'https://fathom.video/share/s1');
    assert.deepEqual(out.attendees, ['Ann']);
    assert.equal(out.duration_minutes, 45);
  });

  it('matches all words across fields and reports where', () => {
    const m = meeting(1, { title: 'Acme sync', default_summary: { template_name: null, markdown_formatted: 'Budget approved' } });
    assert.deepEqual(matchMeeting(m, ['acme', 'budget'], ['title', 'summary']), ['title', 'summary']);
    assert.equal(matchMeeting(m, ['acme', 'budget'], ['title']), null);
  });

  it('ranks transcript snippets by matched words', () => {
    const m = meeting(1, { transcript: [entry('00:00:01', 'price only'), entry('00:00:02', 'price and renewal')] });
    assert.match(transcriptSnippets(m, ['price', 'renewal'])[0], /price and renewal/);
  });

  const speaker = (name: string) => ({ speaker: { display_name: name, matched_calendar_invitee_email: null }, text: 'hi', timestamp: '00:00:01' });

  it('merges an invitee who spoke into one person', () => {
    const m = meeting(1, {
      calendar_invitees: [{ name: 'Alice Smith', email: 'alice@x.com', email_domain: 'x.com', is_external: true, matched_speaker_display_name: 'Alice S.' }],
      transcript: [speaker('Alice S.'), speaker('Bob')]
    });
    assert.deepEqual(peopleOf(m), [
      { name: 'Alice Smith', email: 'alice@x.com', external: true, invited: true, spoke: true, aliases: ['Alice S.'] },
      { name: 'Bob', email: null, external: null, invited: false, spoke: true }
    ]);
  });

  it('prefers a speaker name over an email shown as the invitee name', () => {
    const m = meeting(1, {
      calendar_invitees: [{ name: 'nb@x.com', email: 'nb@x.com', email_domain: 'x.com', is_external: true, matched_speaker_display_name: 'Niklas B' }],
      transcript: [speaker('Niklas B')]
    });
    assert.deepEqual(peopleOf(m)[0], { name: 'Niklas B', email: 'nb@x.com', external: true, invited: true, spoke: true, aliases: ['nb@x.com'] });
  });
});
