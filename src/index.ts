
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { SearchBrowseService } from "./services/search-browse.js";
import yaml from "js-yaml";
import { Logger } from "./utils/logger.js";

// Define our MCP agent with Search and Browse tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "MiniMax Search MCP Server",
		version: "1.0.0",
	});

	// Storage for active SSE sessions
	sessions: Map<string, ReadableStreamDefaultController> = new Map();

	// Registry for tools to allow manual bridging for pure MCP clients
	static toolsRegistry: Map<string, { schema: any, handler: (args: any) => Promise<any>, description: string }> = new Map();

	constructor(state: any, env: any) {
		super(state, env);
	}

	async init() {
		const env = this.env as any;

		const minimaxApiKey = env.MINIMAX_API_KEY;
		const serperApiKey = env.SERPER_API_KEY;
		const jinaApiKey = env.JINA_API_KEY;

		if (!minimaxApiKey || !serperApiKey) {
			Logger.error(`[AGENT] Missing credentials. MINIMAX_API_KEY: ${minimaxApiKey ? "SET" : "MISSING"}, SERPER_API_KEY: ${serperApiKey ? "SET" : "MISSING"}`);
		}

		const service = new SearchBrowseService({
			minimaxApiKey: minimaxApiKey || "",
			serperApiKey: serperApiKey || "",
			jinaApiKey: jinaApiKey || "",
		});

		// Helper to register tool on both server and registry
		const registerTool = (name: string, description: string, schema: any, handler: (args: any) => Promise<any>) => {
			this.server.tool(name, schema, handler);
			MyMCP.toolsRegistry.set(name, { schema, handler, description });
		};

		// 1. search
		registerTool(
			"search",
			"Search Google for a query and return brief snippets.",
			{ query: z.string().describe("Search query") },
			async ({ query }: any) => {
				const result = await service.getSearchResults(query);
				return { content: [{ type: "text" as const, text: result }] };
			}
		);

		// 2. browse
		registerTool(
			"browse",
			"Browse a webpage and answer a specific query based on its content.",
			{
				url: z.string().url().describe("The URL to browse"),
				query: z.string().optional().describe("Specific question or summary request")
			},
			async ({ url, query }: any) => {
				const result = await service.getBrowseResults(url, query || "");
				return { content: [{ type: "text" as const, text: result }] };
			}
		);

		// 3. multi_search
		registerTool(
			"multi_search",
			"Perform multiple searches in parallel.",
			{ queries: z.array(z.string()).describe("A list of search queries") },
			async ({ queries }: any) => {
				const promises = queries.map(async (q: string) => {
					const res = await service.getSearchResults(q);
					return `--- search result for [${q}] ---\n${res}\n--- end of search result ---`;
				});
				const results = await Promise.all(promises);
				return { content: [{ type: "text" as const, text: results.join("\n\n") }] };
			}
		);

		// 4. multi_browse
		registerTool(
			"multi_browse",
			"Browse multiple webpages in parallel and answer a query.",
			{
				urls: z.array(z.string().url()).describe("A list of URLs to browse"),
				query: z.string().optional().describe("Specific question or summary request")
			},
			async ({ urls, query }: any) => {
				const promises = urls.map(async (url: string) => {
					const res = await service.getBrowseResults(url, query || "");
					return `--- answer based on [${url}] ---\n${res}\n--- end of answer ---`;
				});
				const results = await Promise.all(promises);
				return { content: [{ type: "text" as const, text: results.join("\n\n") }] };
			}
		);
	}

	// Manual fetch handler for the Durable Object to support stateful SSE
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/mcp/sse") {
			await this.init();
			const sessionId = crypto.randomUUID();
			const encoder = new TextEncoder();

			const stream = new ReadableStream({
				start: (controller) => {
					this.sessions.set(sessionId, controller);
					controller.enqueue(encoder.encode("event: endpoint\n"));
					controller.enqueue(encoder.encode(`data: ${url.origin}/mcp/messages?sessionId=${sessionId}\n\n`));

					// Keep-alive timer
					const timer = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(": keep-alive\n\n"));
						} catch {
							clearInterval(timer);
							this.sessions.delete(sessionId);
						}
					}, 15000);
				},
				cancel: () => {
					this.sessions.delete(sessionId);
				}
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
				}
			});
		}

		if (url.pathname === "/mcp/messages" && request.method === "POST") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) return new Response("Missing sessionId", { status: 400 });

			const controller = this.sessions.get(sessionId);
			if (!controller) return new Response("Session not found or expired", { status: 404 });

			await this.init();
			const body = await request.json() as any;
			const encoder = new TextEncoder();

			// Handle tools/list manually for standard output
			if (body.method === "tools/list") {
				const availableTools = [];
				for (const [name, tool] of MyMCP.toolsRegistry.entries()) {
					// Prepare inputSchema from simplified mapping
					const properties: any = {};
					const required: string[] = [];

					if (name === "search") {
						properties.query = { type: "string", description: "Search query" };
						required.push("query");
					} else if (name === "browse") {
						properties.url = { type: "string", description: "The URL to browse" };
						properties.query = { type: "string", description: "Specific question or summary request" };
						required.push("url");
					} else if (name === "multi_search") {
						properties.queries = { type: "array", items: { type: "string" }, description: "A list of search queries" };
						required.push("queries");
					} else if (name === "multi_browse") {
						properties.urls = { type: "array", items: { type: "string" }, description: "A list of URLs to browse" };
						properties.query = { type: "string", description: "Specific question or summary request" };
						required.push("urls");
					}

					availableTools.push({
						name,
						description: tool.description,
						inputSchema: { type: "object", properties, required }
					});
				}

				const bridgeResponse = { jsonrpc: "2.0", id: body.id, result: { tools: availableTools } };
				controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(bridgeResponse)}\n\n`));
				return new Response("Accepted", { status: 202 });
			} else if (body.method === "tools/call") {
				const tool = MyMCP.toolsRegistry.get(body.params.name);
				if (!tool) {
					const response = { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Tool not found" } };
					controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`));
				} else {
					// We run this asynchronously to not block the POST response
					(async () => {
						try {
							const result = await tool.handler(body.params.arguments);
							const response = { jsonrpc: "2.0", id: body.id, result };
							controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`));
						} catch (e: any) {
							const response = { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: e.message } };
							controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`));
						}
					})();
				}
				return new Response("Accepted", { status: 202 });
			} else if (body.method === "notifications/initialized" || body.method === "initialize") {
				// Standard MCP initialization handshake
				if (body.method === "initialize") {
					const response = {
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2024-11-05",
							capabilities: {},
							serverInfo: { name: "MiniMax Search MCP Server", version: "1.0.0" }
						}
					};
					controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`));
				}
				return new Response("Accepted", { status: 202 });
			}

			return new Response("Method not supported in bridge mode", { status: 501 });
		}

		// Fallback to agentic fetch for other paths inside DO (if any)
		return super.fetch(request);
	}
}


export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// Pure MCP Bridge (Stateful JSON-RPC over SSE via Durable Object)
		if (url.pathname === "/mcp/sse" || url.pathname === "/mcp/messages") {
			const id = env.MCP_OBJECT.idFromName("global-mcp-instance");
			const obj = env.MCP_OBJECT.get(id);
			return obj.fetch(request);
		}

		// Agentic MCP routes (using agents-sdk)
		if (url.pathname === "/sse" || url.pathname === "/sse/message") return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		if (url.pathname === "/mcp") return MyMCP.serve("/mcp").fetch(request, env, ctx);

		return new Response("Not found", { status: 404 });
	},
};
