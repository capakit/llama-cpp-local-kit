import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import { udsFetch } from "./uds_fetch.ts";

export type LlamaServerManagerOptions = {
    modelsDir: string;
    defaultModel: string;
    releaseTag: string;
    contextSize: number;
    threads: number;
};

type ActiveServer = {
    key: string;
    socketPath: string;
    process: ChildProcess;
    logTail: string[];
    mediaMarker?: string | null;
};

type RuntimeModelSpec = {
    key: string;
    model: string;
    mmproj: string | null;
};

type ModelMemoryEstimate = {
    modelBytes: number;
    estimatedRequiredBytes: number;
    systemMemoryBytes: number;
    ratio: number;
};

type HydratedRuntime = {
    hfHome: string;
    llamaCache: string;
    llamaServer: string;
    modelPath: string;
    mmprojPath: string | null;
};

const DEFAULT_MEMORY_WARN_RATIO = 0.60;
const DEFAULT_MEMORY_FAIL_RATIO = 0.90;
const MODEL_RUNTIME_OVERHEAD_RATIO = 0.20;
const MIN_MODEL_RUNTIME_OVERHEAD_BYTES = 1024 ** 3;
const LLAMA_SERVER_LOG_TAIL_LINES = 30;
const LLAMA_SERVER_LOG_TAIL_LINE_CHARS = 500;

export class LlamaServerManager {
    private active: ActiveServer | null = null;
    private startPromise: Promise<ActiveServer> | null = null;

    constructor(private readonly options: LlamaServerManagerOptions) {}

    async prepare(model: string | undefined = undefined): Promise<void> {
        await hydrateRuntime(this.options, parseRuntimeModelSpec(model ?? this.options.defaultModel), "hydrate");
    }

    async fetch(model: string | undefined, path: string, init: RequestInit): Promise<Response> {
        const server = await this.ensure(model);
        return udsFetch(server.socketPath, `http://llama.local${path}`, init);
    }

    async mediaMarker(model: string | undefined): Promise<string | null> {
        const server = await this.ensure(model);
        if (server.mediaMarker !== undefined) {
            return server.mediaMarker;
        }
        const response = await udsFetch(server.socketPath, "http://llama.local/props");
        if (!response.ok) {
            server.mediaMarker = null;
            return null;
        }
        const props = await response.json() as { media_marker?: unknown };
        server.mediaMarker = typeof props.media_marker === "string" && props.media_marker.length > 0
            ? props.media_marker
            : null;
        return server.mediaMarker;
    }

    async stop(): Promise<void> {
        const active = this.active;
        this.active = null;
        this.startPromise = null;
        if (!active) {
            return;
        }
        active.process.kill("SIGTERM");
        await new Promise<void>((resolve) => {
            active.process.once("exit", () => resolve());
            setTimeout(resolve, 2_000);
        });
        await rm(active.socketPath, { force: true });
    }

    private async ensure(model: string | undefined): Promise<ActiveServer> {
        const target = parseRuntimeModelSpec(model ?? this.options.defaultModel);
        if (this.active?.key === target.key) {
            return this.active;
        }
        if (this.startPromise) {
            const active = await this.startPromise;
            if (active.key === target.key) {
                return active;
            }
        }
        await this.stop();
        this.startPromise = this.start(target).finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    private async start(target: RuntimeModelSpec): Promise<ActiveServer> {
        const runtimeDir = llamaRuntimeDir();
        const { hfHome, llamaCache, llamaServer, modelPath, mmprojPath } = await hydrateRuntime(
            this.options,
            target,
            "cache-only-optional-mmproj",
        );
        await mkdir(runtimeDir, { recursive: true });

        const socketPath = join(runtimeDir, `${shortHash(target.key)}.sock`);
        await rm(socketPath, { force: true });

        const modelArgs = ["--model", modelPath, ...(mmprojPath ? ["--mmproj", mmprojPath] : [])];
        const args = [
            ...modelArgs,
            "--host",
            socketPath,
            "--ctx-size",
            String(this.options.contextSize),
            "--threads",
            String(this.options.threads),
        ];
        const child = spawn(
            llamaServer,
            llamaServerArgs(...args),
            {
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                    ...process.env,
                    HF_HOME: hfHome,
                    HF_HUB_CACHE: join(hfHome, "hub"),
                    LLAMA_CACHE: llamaCache,
                },
            },
        );

        const active = { key: target.key, socketPath, process: child, logTail: [] };
        attachLlamaServerLogs(active);
        await waitForHealth(active);
        this.active = active;
        return active;
    }
}

export async function hydrateLlamaRuntime(
    options: LlamaServerManagerOptions,
    extraModels: string[] = [],
): Promise<void> {
    for (const target of hydrateRuntimeTargets(options.defaultModel, extraModels)) {
        await hydrateRuntime(options, target, "hydrate");
    }
}

async function hydrateRuntime(
    options: LlamaServerManagerOptions,
    target: RuntimeModelSpec,
    optionalMmprojMode: "hydrate" | "cache-only-optional-mmproj",
): Promise<HydratedRuntime> {
    const hfHome = join(options.modelsDir, "hf-home");
    const llamaCache = join(options.modelsDir, "llama-cache");
    const llamaServer = await hydrateLlamaServer(options.modelsDir, options.releaseTag);
    const modelPath = await hydrateModel(options.modelsDir, target.model, "model");
    const mmprojPath = target.mmproj
        ? await hydrateModel(options.modelsDir, target.mmproj, "mmproj")
        : await hydrateOptionalMmproj(options.modelsDir, target.model, optionalMmprojMode);
    await mkdir(hfHome, { recursive: true });
    await mkdir(llamaCache, { recursive: true });
    return {
        hfHome,
        llamaCache,
        llamaServer,
        modelPath,
        mmprojPath,
    };
}

function llamaServerArgs(...base: string[]): string[] {
    if (process.env.CAPAKIT_GPU === "metal") {
        return [...base, "--n-gpu-layers", "999"];
    }
    return [
        ...base,
        "--n-gpu-layers",
        "0",
        "--device",
        "none",
        "--no-mmproj-offload",
        "--fit",
        "off",
        "--no-op-offload",
    ];
}

function llamaRuntimeDir(): string {
    const ingressBind = process.env.CAPAKIT_WORKLOAD_INGRESS_BIND;
    if (ingressBind?.startsWith("unix:")) {
        return dirname(ingressBind.slice("unix:".length));
    }
    return join(process.env.TMPDIR ?? "/tmp", "llama-cpp");
}

function hydrateRuntimeTargets(defaultModel: string, extraModels: string[]): RuntimeModelSpec[] {
    const targets: RuntimeModelSpec[] = [];
    const seen = new Set<string>();
    for (const model of [defaultModel, ...extraModels]) {
        if (!model.trim()) {
            continue;
        }
        const target = parseRuntimeModelSpec(model);
        if (seen.has(target.key)) {
            continue;
        }
        seen.add(target.key);
        targets.push(target);
    }
    return targets;
}

type GgufKind = "model" | "mmproj";

async function hydrateModel(modelsDir: string, model: string, kind: GgufKind): Promise<string> {
    if (isLocalModelSpec(model)) {
        await checkModelMemory(model, await localFileSize(model));
        return model;
    }
    const { repo, selector } = parseModelSpec(model);
    const modelDir = join(modelsDir, "gguf", safeName(repo));
    await mkdir(modelDir, { recursive: true });
    const cached = await findCachedGgufFile(modelDir, selector, kind);
    if (cached) {
        await checkModelMemory(model, await localFileSize(cached));
        return cached;
    }
    const selected = await resolveGgufFile(repo, selector, kind);
    if (!selected) {
        throw new Error(`no GGUF file found in ${repo}${selector ? ` matching ${selector}` : ""}`);
    }
    const { fileName, sizeBytes } = selected;
    const destination = join(modelDir, fileName);
    if (await isExecutable(destination)) {
        await checkModelMemory(model, await localFileSize(destination));
        return destination;
    }
    const url = `https://huggingface.co/${repo}/resolve/main/${encodePath(fileName)}`;
    await checkModelMemory(model, sizeBytes ?? await remoteFileSize(url));
    console.log(`[llama-cpp-local] downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed downloading model ${model}: ${response.status} ${response.statusText}`);
    }
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return destination;
}

async function hydrateOptionalMmproj(
    modelsDir: string,
    model: string,
    mode: "hydrate" | "cache-only-optional-mmproj",
): Promise<string | null> {
    if (isLocalModelSpec(model)) {
        return null;
    }
    const { repo, selector } = parseModelSpec(model);
    const modelDir = join(modelsDir, "gguf", safeName(repo));
    await mkdir(modelDir, { recursive: true });
    const cached = await findCachedGgufFile(modelDir, selector, "mmproj");
    if (cached) {
        return cached;
    }
    if (mode === "cache-only-optional-mmproj") {
        return null;
    }
    const selected = await resolveGgufFile(repo, selector, "mmproj", true);
    if (!selected) {
        return null;
    }
    const destination = join(modelDir, selected.fileName);
    if (await isExecutable(destination)) {
        return destination;
    }
    const url = `https://huggingface.co/${repo}/resolve/main/${encodePath(selected.fileName)}`;
    console.log(`[llama-cpp-local] downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed downloading model ${model}: ${response.status} ${response.statusText}`);
    }
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return destination;
}

async function findCachedGgufFile(
    modelDir: string,
    selector: string | null,
    kind: GgufKind,
): Promise<string | null> {
    let entries;
    try {
        entries = await readdir(modelDir, { withFileTypes: true });
    } catch {
        return null;
    }
    const candidates = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".gguf"))
        .filter((entry) => kind === "mmproj" ? isMmprojFile(entry.name) : !isMmprojFile(entry.name))
        .filter((entry) => !selector || entry.name.toLowerCase().includes(selector.toLowerCase()))
        .map((entry) => entry.name)
        .sort();
    const selected = candidates[0];
    return selected ? join(modelDir, selected) : null;
}

async function checkRemoteHfModelMemory(model: string): Promise<void> {
    const { repo, selector } = parseModelSpec(model);
    const selected = await resolveGgufFile(repo, selector, "model");
    if (!selected) {
        throw new Error(`no GGUF file found in ${repo}${selector ? ` matching ${selector}` : ""}`);
    }
    const { fileName, sizeBytes } = selected;
    const url = `https://huggingface.co/${repo}/resolve/main/${encodePath(fileName)}`;
    await checkModelMemory(model, sizeBytes ?? await remoteFileSize(url));
}

function isLocalModelSpec(model: string): boolean {
    return model.startsWith("/") || model.startsWith(".");
}

function parseModelSpec(model: string): { repo: string; selector: string | null } {
    const [repo, selector] = model.split(":", 2);
    if (!repo.includes("/")) {
        throw new Error(`model \`${model}\` must be a local path or Hugging Face repo id`);
    }
    return { repo, selector: selector ?? null };
}

async function resolveGgufFile(
    repo: string,
    selector: string | null,
    kind: GgufKind,
    optional = false,
): Promise<{ fileName: string; sizeBytes: number | null } | null> {
    const url = `https://huggingface.co/api/models/${repo}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed resolving model repo ${repo}: ${response.status} ${response.statusText}`);
    }
    const body = await response.json() as { siblings?: Array<{ rfilename?: string; size?: number }> };
    const files = body.siblings
        ?.filter((item) => Boolean(item.rfilename?.endsWith(".gguf")))
        .filter((item) => kind === "mmproj" ? isMmprojFile(item.rfilename!) : !isMmprojFile(item.rfilename!))
        ?? [];
    const selected = selector
        ? files.find((file) => file.rfilename?.toLowerCase().includes(selector.toLowerCase()))
        : files[0];
    if (!selected) {
        if (optional) {
            return null;
        }
        throw new Error(`no GGUF file found in ${repo}${selector ? ` matching ${selector}` : ""}`);
    }
    return {
        fileName: selected.rfilename!,
        sizeBytes: typeof selected.size === "number" ? selected.size : null,
    };
}

function isMmprojFile(fileName: string): boolean {
    return fileName.toLowerCase().includes("mmproj");
}

async function localFileSize(path: string): Promise<number> {
    return (await stat(path)).size;
}

async function remoteFileSize(url: string): Promise<number> {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) {
        throw new Error(`failed checking model size: ${response.status} ${response.statusText}`);
    }
    const raw = response.headers.get("content-length");
    const bytes = raw ? Number(raw) : NaN;
    if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error("failed checking model size: missing content-length");
    }
    return bytes;
}

async function checkModelMemory(model: string, modelBytes: number): Promise<void> {
    if ((process.env.LLAMA_CPP_MEMORY_CHECK ?? "on").toLowerCase() === "off") {
        return;
    }
    const estimate = estimateModelMemory(modelBytes);
    const failRatio = memoryRatioEnv("LLAMA_CPP_MEMORY_FAIL_RATIO", DEFAULT_MEMORY_FAIL_RATIO);
    const warnRatio = memoryRatioEnv("LLAMA_CPP_MEMORY_WARN_RATIO", DEFAULT_MEMORY_WARN_RATIO);
    if (estimate.ratio >= failRatio) {
        throw new Error(
            `model ${model} is too large for local memory: ${formatMemoryEstimate(estimate)}. `
            + "Set LLAMA_CPP_MEMORY_CHECK=off to bypass this guard.",
        );
    }
    if (estimate.ratio >= warnRatio) {
        console.warn(`[llama-cpp-local] warning: model ${model} may pressure memory: ${formatMemoryEstimate(estimate)}`);
    }
}

function estimateModelMemory(modelBytes: number): ModelMemoryEstimate {
    const estimatedRequiredBytes = modelBytes
        + Math.max(modelBytes * MODEL_RUNTIME_OVERHEAD_RATIO, MIN_MODEL_RUNTIME_OVERHEAD_BYTES);
    const systemMemoryBytes = totalmem();
    return {
        modelBytes,
        estimatedRequiredBytes,
        systemMemoryBytes,
        ratio: estimatedRequiredBytes / systemMemoryBytes,
    };
}

function memoryRatioEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
        throw new Error(`${key} must be a number between 0 and 1`);
    }
    return parsed;
}

function formatMemoryEstimate(estimate: ModelMemoryEstimate): string {
    return [
        `model=${formatBytes(estimate.modelBytes)}`,
        `estimated_required=${formatBytes(estimate.estimatedRequiredBytes)}`,
        `system_memory=${formatBytes(estimate.systemMemoryBytes)}`,
        `ratio=${Math.round(estimate.ratio * 100)}%`,
    ].join(" ");
}

function formatBytes(bytes: number): string {
    const gib = bytes / 1024 ** 3;
    if (gib >= 1) {
        return `${gib.toFixed(1)}GiB`;
    }
    return `${(bytes / 1024 ** 2).toFixed(0)}MiB`;
}

function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

async function hydrateLlamaServer(modelsDir: string, releaseTag: string): Promise<string> {
    const platform = llamaReleasePlatform();
    const asset = `llama-${releaseTag}-bin-${platform}.tar.gz`;
    const releaseDir = join(modelsDir, "llama.cpp", releaseTag, platform);
    const binary = join(releaseDir, `llama-${releaseTag}`, "llama-server");
    if (await isExecutable(binary)) {
        return binary;
    }

    await mkdir(releaseDir, { recursive: true });
    const archive = join(releaseDir, asset);
    const url = `https://github.com/ggml-org/llama.cpp/releases/download/${releaseTag}/${asset}`;
    console.log(`[llama-cpp-local] downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed downloading llama.cpp release ${releaseTag}: ${response.status} ${response.statusText}`);
    }
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await run("/usr/bin/tar", ["-xzf", archive, "-C", releaseDir]);

    const found = await findFile(releaseDir, "llama-server");
    if (!found) {
        throw new Error(`llama.cpp release ${releaseTag} did not contain llama-server`);
    }
    await chmod(found, 0o755);
    return found;
}

function llamaReleasePlatform(): string {
    if (process.platform === "darwin" && process.arch === "arm64") {
        return "macos-arm64";
    }
    if (process.platform === "darwin" && process.arch === "x64") {
        return "macos-x64";
    }
    if (process.platform === "linux" && process.arch === "x64") {
        return "ubuntu-x64";
    }
    if (process.platform === "linux" && process.arch === "arm64") {
        return "ubuntu-arm64";
    }
    throw new Error(`unsupported llama.cpp release platform ${process.platform}/${process.arch}`);
}

async function isExecutable(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function findFile(root: string, name: string): Promise<string | null> {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isFile() && entry.name === name) {
            return path;
        }
        if (entry.isDirectory()) {
            const found = await findFile(path, name);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

async function run(program: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(program, args, { stdio: ["ignore", "inherit", "inherit"] });
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${program} exited with code ${code}`));
            }
        });
    });
}

async function waitForHealth(server: ActiveServer): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 180_000) {
        if (server.process.exitCode !== null) {
            throw new Error(`llama-server exited with code ${server.process.exitCode}${formatLlamaServerLogTail(server)}`);
        }
        try {
            const response = await udsFetch(server.socketPath, "http://llama.local/health");
            if (response.ok) {
                return;
            }
        } catch {}
        await sleep(500);
    }
    throw new Error(`timed out waiting for llama-server model=${server.key}${formatLlamaServerLogTail(server)}`);
}

function attachLlamaServerLogs(server: ActiveServer): void {
    pipeLlamaServerLogStream(server.process.stdout, server.logTail, "stdout", process.stdout);
    pipeLlamaServerLogStream(server.process.stderr, server.logTail, "stderr", process.stderr);
}

function pipeLlamaServerLogStream(
    stream: Readable | null,
    tail: string[],
    label: string,
    output: NodeJS.WriteStream,
): void {
    if (!stream) {
        return;
    }

    let pending = "";
    stream.on("data", (chunk: Buffer | string) => {
        pending += chunk.toString();
        const parts = pending.split(/[\r\n]+/);
        pending = parts.pop() ?? "";
        for (const line of parts) {
            ingestLlamaServerLogLine(tail, label, line, output);
        }
    });
    stream.on("end", () => {
        ingestLlamaServerLogLine(tail, label, pending, output);
        pending = "";
    });
}

function ingestLlamaServerLogLine(
    tail: string[],
    label: string,
    rawLine: string,
    output: NodeJS.WriteStream,
): void {
    const line = rawLine.trim();
    if (!line) {
        return;
    }
    output.write(`${line}\n`);
    tail.push(`${label}: ${truncateLogLine(line)}`);
    if (tail.length > LLAMA_SERVER_LOG_TAIL_LINES) {
        tail.splice(0, tail.length - LLAMA_SERVER_LOG_TAIL_LINES);
    }
}

function formatLlamaServerLogTail(server: ActiveServer): string {
    if (server.logTail.length === 0) {
        return "";
    }
    return `\nrecent llama-server logs:\n${server.logTail.map((line) => `  ${line}`).join("\n")}`;
}

function truncateLogLine(line: string): string {
    if (line.length <= LLAMA_SERVER_LOG_TAIL_LINE_CHARS) {
        return line;
    }
    return `${line.slice(0, LLAMA_SERVER_LOG_TAIL_LINE_CHARS)}...`;
}

function parseRuntimeModelSpec(model: string): RuntimeModelSpec {
    const trimmed = model.trim();
    if (!trimmed) {
        throw new Error("model must not be empty");
    }
    const [modelSpec, rawParams] = trimmed.split("?", 2);
    const params = new URLSearchParams(rawParams ?? "");
    const mmproj = params.get("mmproj")?.trim() || null;
    return {
        key: mmproj ? `${modelSpec}?mmproj=${mmproj}` : modelSpec,
        model: modelSpec,
        mmproj,
    };
}

function safeName(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80);
}

function shortHash(value: string): string {
    let hash = 0x811c9dc5;
    for (const ch of value) {
        hash ^= ch.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
