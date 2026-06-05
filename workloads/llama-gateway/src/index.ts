import { createWorkloadSdk, endpointPath, hostMountMid } from "@capakit/sdk";

import { LlamaServerManager } from "./llama_server.ts";
import { registerMcp } from "./mcp_tools.ts";
import { registerOaic } from "./oaic_proxy.ts";

const sdk = createWorkloadSdk({
    onShutdown: async () => {
        await llama.stop();
    },
});
sdk.hijackConsoleLogging();

const modelsMount = sdk.mounts.get(hostMountMid("models"));
if (!modelsMount) {
    throw new Error("missing required host mount `models`");
}

const llama = new LlamaServerManager({
    modelsDir: modelsMount.path,
    defaultModel: process.env.LLAMA_CPP_DEFAULT_MODEL
        ?? "ggml-org/gemma-3-270m-it-GGUF:Q8_0",
    releaseTag: process.env.LLAMA_CPP_RELEASE_TAG ?? "b9060",
    contextSize: Number(process.env.LLAMA_CPP_CONTEXT_SIZE ?? "2048"),
    threads: Number(process.env.LLAMA_CPP_THREADS ?? "4"),
});

registerOaic(sdk, llama, endpointPath("/oaic"));
registerMcp(sdk, llama, endpointPath("/mcp"));

await sdk.start();
