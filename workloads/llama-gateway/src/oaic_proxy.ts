import type { EndpointPath, RunnerSdk } from "@capakit/sdk";
import { mountOaic } from "@capakit/sdk/oaic";

import type { LlamaServerManager } from "./llama_server.ts";

type OaicPayload = {
    model?: string;
    messages?: OaicMessage[];
    [key: string]: unknown;
};

type OaicMessage = {
    content?: unknown;
    [key: string]: unknown;
};

type OaicContentPart = {
    type?: unknown;
    text?: unknown;
    [key: string]: unknown;
};

export function registerOaic(
    sdk: RunnerSdk,
    llama: LlamaServerManager,
    endpoint: EndpointPath,
): void {
    mountOaic(sdk, {
        endpoint,
        handler: async (request) => {
            const url = new URL(request.url);
            const payload = await request.clone().json().catch(() => null) as OaicPayload | null;
            const upstreamPath = oaicUpstreamPath(url, endpoint);
            const headers = new Headers(request.headers);
            headers.delete("content-length");
            const upstreamPayload = payload
                ? await normalizeOaicPayload(llama, upstreamPath, payload)
                : null;
            return llama.fetch(payload?.model, upstreamPath, {
                method: request.method,
                headers,
                body: upstreamPayload ? JSON.stringify(upstreamPayload) : request.body,
            });
        },
    });
}

async function normalizeOaicPayload(
    llama: LlamaServerManager,
    upstreamPath: string,
    payload: OaicPayload,
): Promise<OaicPayload> {
    const normalized = {
        ...payload,
        model: stripModelParams(payload.model),
    };
    if (!isChatCompletionsPath(upstreamPath) || !messagesContainImages(normalized.messages)) {
        return normalized;
    }

    // llama.cpp currently needs its per-process media marker in multimodal prompts.
    // https://github.com/ggml-org/llama.cpp/issues/22490
    const marker = await llama.mediaMarker(payload.model);
    if (!marker) {
        throw new Error("llama.cpp server did not expose /props.media_marker for multimodal chat request");
    }
    normalized.messages = normalized.messages?.map((message) =>
        injectMissingMediaMarkers(message, marker)
    );
    return normalized;
}

function stripModelParams(model: string | undefined): string | undefined {
    return model?.split("?", 1)[0];
}

function isChatCompletionsPath(path: string): boolean {
    return path === "/v1/chat/completions" || path.startsWith("/v1/chat/completions?");
}

function messagesContainImages(messages: OaicMessage[] | undefined): boolean {
    return messages?.some((message) => contentImageCount(message.content) > 0) ?? false;
}

function injectMissingMediaMarkers(message: OaicMessage, marker: string): OaicMessage {
    const imageCount = contentImageCount(message.content);
    if (imageCount === 0 || !Array.isArray(message.content)) {
        return message;
    }

    const markerCount = contentMarkerCount(message.content, marker);
    const missingCount = imageCount - markerCount;
    if (missingCount <= 0) {
        return message;
    }

    const markerText = Array.from({ length: missingCount }, () => marker).join("\n");
    const content = [...message.content] as OaicContentPart[];
    const textIndex = content.findIndex((part) => part.type === "text" && typeof part.text === "string");
    if (textIndex >= 0) {
        const part = content[textIndex];
        content[textIndex] = {
            ...part,
            text: `${markerText}\n${part.text}`,
        };
    } else {
        content.unshift({
            type: "text",
            text: markerText,
        });
    }
    return {
        ...message,
        content,
    };
}

function contentImageCount(content: unknown): number {
    if (!Array.isArray(content)) {
        return 0;
    }
    return content.filter((part) => isImageUrlPart(part)).length;
}

function contentMarkerCount(content: unknown, marker: string): number {
    if (!Array.isArray(content)) {
        return 0;
    }
    return content
        .filter((part): part is OaicContentPart => isTextPart(part))
        .reduce((count, part) => count + markerOccurrences(String(part.text), marker), 0);
}

function isImageUrlPart(part: unknown): boolean {
    return isRecord(part) && part.type === "image_url";
}

function isTextPart(part: unknown): part is OaicContentPart {
    return isRecord(part) && part.type === "text" && typeof part.text === "string";
}

function markerOccurrences(text: string, marker: string): number {
    return text.split(marker).length - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function oaicUpstreamPath(url: URL, endpoint: EndpointPath): string {
    const endpointPath = endpoint.toString();
    const path = url.pathname.startsWith(`${endpointPath}/`)
        ? url.pathname.slice(endpointPath.length)
        : url.pathname;
    const normalized = path.startsWith("/v1/") ? path : `/v1${path}`;
    return `${normalized}${url.search}`;
}
