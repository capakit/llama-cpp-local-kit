import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EndpointPath, WorkloadSdk } from "@capakit/sdk";
import { mountMcp } from "@capakit/sdk/mcp";
import { z } from "zod";

import type { LlamaServerManager } from "./llama_server.ts";

export function registerMcp(
    sdk: WorkloadSdk,
    llama: LlamaServerManager,
    endpoint: EndpointPath,
): void {
    const mcpServer = new McpServer({
        name: process.env.CAPAKIT_WORKLOAD_MID ?? "llama-cpp-local",
        version: "0.1.0",
    });

    mcpServer.registerTool(
        "ask_local_model",
        {
            description: "Ask the local llama.cpp model through the kit OAIC gateway.",
            inputSchema: {
                prompt: z.string().describe("Prompt to send to the local model."),
                model: z.string().optional().describe("Optional Hugging Face GGUF model id."),
            },
        },
        async ({ prompt, model }) => {
            const response = await llama.fetch(model, "/v1/chat/completions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model: model ?? process.env.LLAMA_CPP_DEFAULT_MODEL,
                    messages: [{ role: "user", content: prompt }],
                    stream: false,
                }),
            });
            if (!response.ok) {
                throw new Error(`llama.cpp request failed: ${response.status} ${await response.text()}`);
            }
            const json = await response.json() as {
                model?: string;
                choices?: Array<{ message?: { content?: string } }>;
            };
            const content = json.choices?.[0]?.message?.content ?? "";
            return {
                content: [{ type: "text", text: content }],
                structuredContent: {
                    model: json.model ?? model ?? process.env.LLAMA_CPP_DEFAULT_MODEL,
                    content,
                },
            };
        },
    );

    mountMcp(sdk, {
        endpoint,
        server: mcpServer,
    });
}
