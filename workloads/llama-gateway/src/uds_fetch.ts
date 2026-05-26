import { request as requestHttp } from "node:http";
import type { IncomingHttpHeaders, OutgoingHttpHeaders, RequestOptions } from "node:http";
import { Readable } from "node:stream";

export async function udsFetch(
    socketPath: string,
    input: string,
    init: RequestInit = {},
): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body;
    const body = hasBody ? Buffer.from(await request.arrayBuffer()) : null;

    return new Promise<Response>((resolve, reject) => {
        const req = requestHttp(rawRequestOptions(socketPath, request, url, body), (response) => {
            resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
                status: response.statusCode ?? 200,
                headers: nodeHeadersToWeb(response.headers),
            }));
        });
        req.on("error", reject);
        req.end(body ?? undefined);
    });
}

function rawRequestOptions(
    socketPath: string,
    request: Request,
    url: URL,
    body: Buffer | null,
): RequestOptions {
    const headers = webHeadersToNode(request.headers);
    if (body && headers["content-length"] === undefined) {
        headers["content-length"] = String(body.length);
    }
    return {
        socketPath,
        host: "localhost",
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
    };
}

function webHeadersToNode(headers: Headers): OutgoingHttpHeaders {
    const raw: OutgoingHttpHeaders = {};
    headers.forEach((value, key) => {
        raw[key] = value;
    });
    return raw;
}

function nodeHeadersToWeb(headers: IncomingHttpHeaders): Headers {
    const web = new Headers();
    for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
            web.set(key, value.join(", "));
        } else if (value !== undefined) {
            web.set(key, value);
        }
    }
    return web;
}
