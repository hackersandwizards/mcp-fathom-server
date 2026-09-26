# MCP Fathom Server

A local MCP server for the [Fathom](https://fathom.video) meeting recorder. It runs over stdio and reads the Fathom API with your personal API key.

Fathom also runs a hosted MCP server at `https://api.fathom.ai/mcp` with OAuth sign-in. This repository's `.mcp.json` connects it in Claude Code, so both can be compared side by side.

## What it can do

| Tool | What it does |
|------|--------------|
| `list_meetings` | Lists meetings newest first. Filters: date range, company domain, internal or external, meeting type, recorder, team. Adds summaries, action items, highlights or CRM matches on request. Pages with `next_cursor`. |
| `search_meetings` | Finds meetings by keywords and by attendee name or email. Searches titles, summaries, action items, highlights and transcripts, and returns timestamped snippets for transcript hits. |
| `get_meeting_summary` | Returns one meeting's AI summary as Markdown. |
| `get_meeting_transcript` | Returns one transcript, one line per speaker turn. With the meeting `url`, each timestamp links to that moment in the recording. Long transcripts page with `start`. |
| `list_teams`, `list_team_members`, `list_meeting_types` | Return the exact names the filters expect. |
| `find_person` | Finds people by name or email in the team roster and among invitees of recent meetings. |
| `create_webhook`, `delete_webhook` | Register or remove a webhook that receives each new meeting. |

Meeting links are the public share URLs (`fathom.video/share/...`), so people without a Fathom login can open them.

Transcripts and summaries are also readable as resources (`fathom://recordings/{recording_id}/transcript` and `/summary`). Two prompts, `meeting_prep` and `meeting_recap`, show up as slash commands in Claude Code.

Every read tool is marked read-only, so clients can run it without asking. `delete_webhook` is marked destructive.

## Limits of the Fathom API

- Fathom has no search endpoint. `search_meetings` scans meetings 10 per request and matches locally. The API allows 60 requests per minute, and 30 or fewer for summaries and transcripts, so a scan of 100 meetings takes 10 requests. The server waits and retries when Fathom answers with a rate limit.
- The API key sees the meetings its user recorded or that were shared with that user or their team.
- Fathom cannot filter by a single attendee. `search_meetings` filters attendees locally.
- Fathom has no endpoint to list webhooks, and shows a webhook's secret only once. `create_webhook` returns both, so store them.
- The ID in a `fathom.video/calls/<id>` link is not the `recording_id` the API uses.

## Setup

You need Node.js 20 or later and a Fathom API key from the API Access section of your [Fathom user settings](https://fathom.video/customize#api-access-header).

```bash
git clone https://github.com/hackersandwizards/mcp-fathom-server.git
cd mcp-fathom-server
npm install
npm run build
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
npm test          # unit and in-process MCP tests, no network
npm run dev       # runs from source, reads FATHOM_API_KEY from .env
npm run inspect   # MCP Inspector against the build
```

Copy `.env.example` to `.env` for `npm run dev`. The server itself reads only its environment, never a `.env` file, so a project's `.env` cannot change it. In the Inspector, set `FATHOM_API_KEY` under Environment Variables.

## License

MIT, see [LICENSE](LICENSE). Originally written by [@petesena](https://twitter.com/petesena) as [sourcegate/mcp-fathom-server](https://github.com/sourcegate/mcp-fathom-server).
