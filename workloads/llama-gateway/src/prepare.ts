import { hydrateLlamaRuntime } from "./llama_server.ts";

const modelsDir = process.env.CAPAKIT_MOUNT_MODELS;
if (!modelsDir) {
    throw new Error("missing required host mount env `CAPAKIT_MOUNT_MODELS`");
}

await hydrateLlamaRuntime({
    modelsDir,
    defaultModel: process.env.LLAMA_CPP_DEFAULT_MODEL
        ?? "ggml-org/gemma-3-270m-it-GGUF:Q8_0",
    releaseTag: process.env.LLAMA_CPP_RELEASE_TAG ?? "b9060",
    contextSize: Number(process.env.LLAMA_CPP_CONTEXT_SIZE ?? "2048"),
    threads: Number(process.env.LLAMA_CPP_THREADS ?? "4"),
}, hydrateModels(process.env.LLAMA_CPP_HYDRATE_MODELS));

function hydrateModels(value: string | undefined): string[] {
    return value
        ?.split(/[,\n]/)
        .map((model) => model.trim())
        .filter(Boolean)
        ?? [];
}
