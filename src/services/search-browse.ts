
import OpenAI from "openai";
import { Logger } from "../utils/logger.js";

export interface SearchResult {
    title: string;
    link?: string;
    url?: string;
    snippet?: string;
    description?: string;
    extra_snippets?: string[];
}

export class SearchBrowseService {
    private openai: any;
    private serperApiKey: string;
    private jinaApiKey: string;

    constructor(config: { minimaxApiKey: string, serperApiKey: string, jinaApiKey: string }) {
        this.openai = new OpenAI({
            apiKey: config.minimaxApiKey,
            baseURL: "https://api.minimax.io/v1",
        });
        this.serperApiKey = config.serperApiKey;
        this.jinaApiKey = config.jinaApiKey;
    }

    async getAiResponse(query: string, maxRetry = 2): Promise<string | null> {
        for (let i = 0; i < maxRetry; i++) {
            try {
                const response = await this.openai.chat.completions.create({
                    model: "MiniMax-M2",
                    messages: [
                        { role: "system", content: "You are a helpful assistant." },
                        { role: "user", content: query },
                    ],
                });
                let content = response.choices[0].message.content || "";
                // Remove <think> tags like in the python version
                content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
                return content;
            } catch (error: any) {
                Logger.error(`[AI] Error (attempt ${i + 1}): ${error.message}`);
                if (i < maxRetry - 1) {
                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
                }
            }
        }
        return null;
    }

    async searchGoogle(query: string): Promise<SearchResult[]> {
        if (!this.serperApiKey) throw new Error("SERPER_API_KEY is missing");
        const response = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: {
                "X-API-KEY": this.serperApiKey,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ q: query, num: 10 }),
        });
        if (!response.ok) throw new Error(`Serper API error: ${response.statusText}`);
        const data = await response.json() as any;
        return data.organic || [];
    }

    getBriefText(contents: SearchResult[]): string {
        let sourceText = "";
        for (const content of contents) {
            let snippet = "";
            if (content.extra_snippets && content.extra_snippets.length > 0) {
                snippet = content.extra_snippets.join("\n");
            } else if (content.snippet) {
                snippet = content.snippet;
            } else {
                snippet = content.description || "";
            }
            const url = content.url || content.link || "";
            sourceText += `<title>${content.title}</title>\n<url>${url}</url>\n<snippet>\n${snippet}\n</snippet>\n\n`;
        }
        return sourceText.trim();
    }

    async getSearchResults(query: string, maxRetry = 3): Promise<string> {
        if (!query.trim()) return "Search result is empty. Please try again.";
        let sourceText = "";
        for (let i = 0; i < maxRetry; i++) {
            try {
                const results = await this.searchGoogle(query);
                sourceText = this.getBriefText(results);
                if (sourceText) break;
            } catch (error: any) {
                Logger.error(`[SEARCH] Error (attempt ${i + 1}): ${error.message}`);
                if (i < maxRetry - 1) {
                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
                }
            }
        }

        if (!sourceText) {
            if (query.includes('"')) {
                const cleaned = query.replace(/"/g, "");
                const message = `Search result for query [${query}] is empty. Return search result for cleaned query instead.`;
                const fallback = await this.getSearchResults(cleaned);
                return (fallback && !fallback.includes("Please try again")) ? `${message}\n\n${fallback}` : "Search result is empty. Please try again.";
            }
            return "Search result is empty. Please try again.";
        }
        return sourceText;
    }

    async readJina(url: string): Promise<string> {
        const headers: any = {
            "X-Engine": "direct",
            "Content-Type": "application/json",
            "X-Retain-Images": "none",
            "X-Return-Format": "markdown",
            "X-Timeout": "60",
        };
        if (this.jinaApiKey) {
            headers["Authorization"] = `Bearer ${this.jinaApiKey}`;
        }
        const response = await fetch("https://r.jina.ai/", {
            method: "POST",
            headers: headers,
            body: JSON.stringify({ url }),
        });
        if (!response.ok) throw new Error(`Jina API error: ${response.statusText}`);
        return await response.text();
    }

    async getBrowseAnswer(sourceText: string, browseQuery: string, maxRetry = 2): Promise<string | null> {
        // Simple estimation: 1 token ~ 4 characters
        const tokenLimit = 190000;
        const charLimit = tokenLimit * 4;

        if (sourceText.length > charLimit) {
            const numSplit = Math.ceil(sourceText.length / charLimit);
            const chunkLen = Math.ceil(sourceText.length / numSplit);
            Logger.log(`[BROWSE] Content too long (${sourceText.length} chars), splitting into ${numSplit} parts`);

            const promises = [];
            for (let i = 0; i < numSplit; i++) {
                const chunk = sourceText.slice(i * chunkLen, (i + 1) * chunkLen + 1024);
                const query = `Please read the source content and answer a following question:\n--- begin of source content ---\n${chunk}\n--- end of source content ---\n\nIf there is no relevant information, please clearly refuse to answer.\nWhen answering, please identify and extract the original content as the evidence. Now answer the question based on the above content:\n${browseQuery}`;
                promises.push(this.getAiResponse(query, maxRetry));
            }

            const results = await Promise.all(promises);
            let combined = "Since the content is too long, the result is split and answered separately. Please combine the results to get the complete answer.\n";
            for (let i = 0; i < results.length; i++) {
                if (!results[i]) return null;
                combined += `--- begin of result part ${i + 1} ---\n${results[i]}\n--- end of result part ${i + 1} ---\n\n`;
            }
            return combined;
        } else {
            const query = `Please read the source content and answer a following question:\n---begin of source content---\n${sourceText}\n---end of source content---\n\nIf there is no relevant information, please clearly refuse to answer.\nWhen answering, please identify and extract the original content as the evidence. Now answer the question based on the above content:\n${browseQuery}`;
            return this.getAiResponse(query, maxRetry);
        }
    }

    async getBrowseResults(url: string, browseQuery: string, maxRetry = 3): Promise<string> {
        let sourceText = "";
        for (let i = 0; i < maxRetry; i++) {
            try {
                sourceText = await this.readJina(url);
                if (sourceText) break;
            } catch (error: any) {
                Logger.error(`[BROWSE] Error reading ${url} (attempt ${i + 1}): ${error.message}`);
                if (error.message.includes("Client Error")) return "Access to this URL is denied. Please try again.";
                if (i < maxRetry - 1) {
                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
                }
            }
        }

        if (!sourceText || !sourceText.trim()) return "Browse error. Please try again.";
        const query = browseQuery || "Detailed summary of the page.";
        const output = await this.getBrowseAnswer(sourceText, query, maxRetry);
        return output?.trim() || "Browse error. Please try again.";
    }
}
