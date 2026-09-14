#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { 
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListToolsRequest,
  CallToolRequest,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequest,
  ListPromptsRequest
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { FathomClient } from "./fathom-client.js";
import dotenv from "dotenv";

dotenv.config();

// A client that cached this tool's schema before include_summary existed sends it as a plain
// string ("true"/"false") rather than a JSON boolean; accept both instead of hard-failing.
const booleanish = z.preprocess(
  (value) => (typeof value === 'string' ? value === 'true' : value),
  z.boolean()
);

const ListMeetingsSchema = z.object({
  calendar_invitees: z.array(z.string()).optional().describe("Filter by attendee email addresses"),
  calendar_invitees_domains: z.array(z.string()).optional().describe("Filter by company domains"),
  created_after: z.string().optional().describe("Filter meetings created after this date (ISO 8601)"),
  created_before: z.string().optional().describe("Filter meetings created before this date (ISO 8601)"),
  include_summary: booleanish.optional().default(false).describe("Include each meeting's summary in the response"),
  include_transcript: z.boolean().optional().default(false).describe("Include meeting transcripts"),
  meeting_type: z.string().optional().describe("Filter by a custom meeting type name configured in Fathom (see the /meeting_types endpoint); omit to include every type"),
  recorded_by: z.array(z.string()).optional().describe("Filter by meeting owner email addresses"),
  teams: z.array(z.string()).optional().describe("Filter by team names"),
  limit: z.number().optional().default(50).describe("Maximum number of meetings to return")
});

const SearchMeetingsSchema = z.object({
  search_term: z.string().describe("Search term to find in meeting titles, summaries, or action items"),
  include_summary: booleanish.optional().default(false).describe("Include each meeting's summary in the response"),
  include_transcript: z.boolean().optional().default(false).describe("Whether to search within transcripts (WARNING: Currently disabled for performance)")
});

const apiKey = process.env.FATHOM_API_KEY;
if (!apiKey) {
  console.error("Error: FATHOM_API_KEY environment variable is required");
  console.error("Please set it in your environment variables or Claude Desktop config");
  console.error("See README.md for setup instructions");
  process.exit(1);
}

const fathomClient = new FathomClient(apiKey);

const server = new Server({
  name: "mcp-fathom-server",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {},
    resources: {},
    prompts: {}
  }
});

server.setRequestHandler(ListToolsRequestSchema, async (request: ListToolsRequest) => ({
  tools: [
    {
      name: "list_meetings",
      description: "List Fathom meetings with optional filters. Returns meeting titles, summaries, dates, and participants.",
      inputSchema: zodToJsonSchema(ListMeetingsSchema)
    },
    {
      name: "search_meetings",
      description: "Search for meetings containing keywords in titles, summaries, or action items. NOTE: Searches last 30 days only, paged up to 5 API pages (response sets truncated: true if more remain). For better performance, transcript search is disabled by default.",
      inputSchema: zodToJsonSchema(SearchMeetingsSchema)
    }
  ]
}));

// Add stub handlers for resources and prompts to prevent "Method not found" errors
server.setRequestHandler(ListResourcesRequestSchema, async (request: ListResourcesRequest) => ({
  resources: []
}));

server.setRequestHandler(ListPromptsRequestSchema, async (request: ListPromptsRequest) => ({
  prompts: []
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;
  
  try {
    if (name === "list_meetings") {
      const params = ListMeetingsSchema.parse(args);
      const limit = params.limit || 50;
      const { limit: _, ...apiParams } = params;
      
      console.error(`[list_meetings] Fetching meetings with params:`, JSON.stringify(apiParams));
      const response = await fathomClient.listMeetings(apiParams);
      console.error(`[list_meetings] Got ${response.items.length} meetings`);
      const meetings = response.items.slice(0, limit);
      
      const formattedMeetings = meetings.map(meeting => ({
        title: meeting.title || meeting.meeting_title,
        date: meeting.scheduled_start_time || meeting.created_at,
        url: meeting.share_url || meeting.url,
        attendees: meeting.calendar_invitees,
        recorded_by: meeting.recorded_by,
        summary: meeting.default_summary,
        action_items: meeting.action_items,
        transcript: params.include_transcript ? meeting.transcript : undefined
      }));
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_found: response.items.length,
            showing: meetings.length,
            meetings: formattedMeetings,
            has_more: !!response.next_cursor
          }, null, 2)
        }]
      };
    }
    
    if (name === "search_meetings") {
      const params = SearchMeetingsSchema.parse(args);
      
      console.error(`[search_meetings] Searching for: "${params.search_term}" (transcript=${params.include_transcript})`);
      const { meetings, truncated } = await fathomClient.searchMeetings(
        params.search_term,
        params.include_transcript,
        params.include_summary
      );
      console.error(`[search_meetings] Found ${meetings.length} matching meetings`);
      
      const formattedMeetings = meetings.map(meeting => ({
        title: meeting.title || meeting.meeting_title,
        date: meeting.scheduled_start_time || meeting.created_at,
        url: meeting.share_url || meeting.url,
        attendees: meeting.calendar_invitees,
        recorded_by: meeting.recorded_by,
        summary: meeting.default_summary,
        action_items: meeting.action_items,
        relevance: params.include_transcript && meeting.transcript?.toLowerCase().includes(params.search_term.toLowerCase()) 
          ? "Found in transcript" 
          : "Found in title/summary"
      }));
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            search_term: params.search_term,
            total_found: meetings.length,
            meetings: formattedMeetings,
            truncated
          }, null, 2)
        }]
      };
    }
    
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    console.error(`Error in ${name}:`, errorMessage);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ error: errorMessage }, null, 2)
      }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fathom MCP Server started successfully");
  console.error(`Connected to Fathom API`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});