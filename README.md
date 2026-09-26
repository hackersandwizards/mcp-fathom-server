# MCP Fathom Server

A local MCP server for the [Fathom](https://fathom.video) meeting recorder. It runs over stdio and reads the Fathom API with your personal API key.

Fathom also runs a hosted MCP server at `https://api.fathom.ai/mcp` with OAuth sign-in. Compared on 2026-09-26, it returns only `fathom.video/calls/` links that need a Fathom login, never share links, and it cannot manage webhooks. This server covers its link lookup and speaker search through the local meeting index.

## What it can do

| Tool | What it does |
|------|--------------|
| `list_meetings` | Lists meetings newest first. Filters: date range, company domain, internal or external, meeting type, recorder, team. Adds summaries, action items, highlights or CRM matches on request. Pages with `next_cursor`. |
| `search_meetings` | Finds meetings by keywords and by attendee name or email. Searches titles, summaries, action items, highlights and transcripts, and returns timestamped snippets for transcript hits. |
| `find_meeting_by_link` | Resolves a pasted `fathom.video/calls/...` or `/share/...` link, or a call ID, to its meeting and share URL, across the whole history. |
| `get_meeting_summary` | Returns one meeting's AI summary as Markdown. |
| `get_meeting_transcript` | Returns one transcript, one line per speaker turn. With the meeting `url`, each timestamp links to that moment in the recording. Long transcripts page with `start`. |
| `list_teams`, `list_team_members`, `list_meeting_types` | Return the exact names the filters expect. |
| `find_person` | Finds people by name or email among everyone who spoke in or was invited to a meeting, plus the team roster, across the whole history. |
| `create_webhook`, `delete_webhook` | Register or remove a webhook that receives each new meeting. |

Meeting links are the public share URLs (`fathom.video/share/...`), so people without a Fathom login can open them.

Transcripts and summaries are also readable as resources (`fathom://recordings/{recording_id}/transcript` and `/summary`). Two prompts, `meeting_prep` and `meeting_recap`, show up as slash commands in Claude Code.

Every read tool is marked read-only, so clients can run it without asking. `delete_webhook` is marked destructive.

## Local meeting index

The Fathom API has no speaker index and no link lookup. So the server builds its own index: for every meeting it keeps the title, date, both links, and the names and emails of invitees and speakers. It keeps no transcript text and no summaries. `find_person` and `find_meeting_by_link` search this index, which covers the whole history.

- **Where:** `~/.cache/mcp-fathom-server/index-<key id>.json` (or under `$XDG_CACHE_HOME`), one file per API key, readable only by you.
- **Building it:** on first start the server reads the history once in the background, 10 meetings with transcripts every few seconds. That uses about half of Fathom's transcript rate limit, so tool calls keep working. An interrupted build resumes where it stopped. Until it finishes, both tools report how far back the index reaches.
- **Keeping it current:** a background loop fetches new meetings every 10 minutes, re-reading one day of overlap so late transcripts fill in. `find_person` also fetches new meetings first, at most once a minute. `find_meeting_by_link` does so when the link is not in the index yet. Once a week the loop walks the whole history again without transcripts, which adds meetings shared with you later and drops deleted ones. Until then, a meeting shared with you after it was recorded can be missing from the index.
- **Several sessions:** one server process per API key holds a lock file and writes the index. Other processes read the file when it changes and fetch newer meetings into memory. They take over the lock when the writer exits, or when it has not touched the lock for 15 minutes.
- **No writable cache:** the server still starts. Both tools then scan recent meetings, as with the index off.
- **Turning it off:** set `FATHOM_INDEX=off`. Both tools then scan recent meetings instead, and nothing is written to disk.

## Limits of the Fathom API

- Fathom has no search endpoint. `search_meetings` scans meetings 10 per request and matches locally. The API allows 60 requests per minute, and 30 or fewer for summaries and transcripts, so a scan of 100 meetings takes 10 requests. The server waits and retries when Fathom answers with a rate limit.
- The API key sees the meetings its user recorded or that were shared with that user or their team. Meetings recorded by someone outside your organisation and shared with you are the exception: the API never lists them, so no search, `find_person` or `find_meeting_by_link` result includes them, although `get_meeting_summary` and `get_meeting_transcript` read them by `recording_id` (checked 2026-09-26).
- Fathom cannot filter by a single attendee. `search_meetings` filters attendees locally.
- Fathom has no endpoint to list webhooks, and shows a webhook's secret only once. `create_webhook` returns both, so store them.
- The ID in a `fathom.video/calls/<id>` link is not the `recording_id` the API uses, and the API has no lookup. `find_meeting_by_link` uses the local index instead.

## Setup

You need Node.js 20 or later to run the server, [Bun](https://bun.sh) 1.4.2 or later to install and build it, and a Fathom API key from the API Access section of your [Fathom user settings](https://fathom.video/customize#api-access-header).

```bash
git clone https://github.com/hackersandwizards/mcp-fathom-server.git
cd mcp-fathom-server
bun install
bun run build
```

Claude Code:

```bash
claude mcp add fathom -e FATHOM_API_KEY=your-key -- node /absolute/path/to/mcp-fathom-server/dist/index.js
```

Claude Desktop: add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart the app.

```json
{
  "mcpServers": {
    "fathom": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-fathom-server/dist/index.js"],
      "env": { "FATHOM_API_KEY": "your-key" }
    }
  }
}
```

## Development

```bash
bun run check     # typecheck plus unit and in-process MCP tests, no network
bun run dev       # runs from source with Bun, which reads FATHOM_API_KEY from .env
bun run inspect   # MCP Inspector against the build
```

Copy `.env.example` to `.env` for `bun run dev`. The server itself reads only its environment, never a `.env` file, so a project's `.env` cannot change it. In the Inspector, set `FATHOM_API_KEY` under Environment Variables.

## License

MIT, see [LICENSE](LICENSE). Originally written by [@petesena](https://twitter.com/petesena) as [sourcegate/mcp-fathom-server](https://github.com/sourcegate/mcp-fathom-server).
