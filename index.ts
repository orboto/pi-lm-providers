/**
 * Local/cloud LLM providers for pi — registers:
 *
 *   ollama   → local Ollama server + Ollama Cloud (https://ollama.com)
 *   lmstudio → LM Studio developer server (incl. LM Studio Bionic)
 *
 * Both are dynamic: models are discovered live from the server with real
 * capabilities (tools / vision / thinking) and context windows where the
 * server exposes them. See ollama.ts / lmstudio.ts for configuration details.
 *
 * Discovery happens twice:
 *   1. in the async factory below (so models show up immediately, including
 *      in `pi --list-models` — pi's initial catalog refresh runs before
 *      extensions load, so providers cannot rely on refreshModels alone).
 *      The factory honors a stored /login credential from auth.json so the
 *      startup catalog matches the chosen endpoint (cloud vs local).
 *   2. via `fetchModels` for later dynamic model refreshes
 *
 * Refresh failures are logged to ~/.pi/agent/lm-providers.log — pi's UI only
 * surfaces "Could not refresh <provider>" without the underlying cause.
 *
 * Usage:
 *   /login ollama    → choose Ollama Cloud (API key) or a local server
 *   /login lmstudio  → optional: store an API token (default: no auth)
 *   /model           → pick a discovered model
 *
 * A local server works without /login — the provider is considered configured
 * as soon as it can be reached (a dummy key is used for keyless servers).
 */
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Model, RefreshModelsContext } from "@earendil-works/pi-coding-agent";
import { lmStudioAuth, lmStudioFetchModels } from "./lmstudio.ts";
import { ollamaAuth, ollamaFetchModels } from "./ollama.ts";
import { readStoredCredential } from "./shared.ts";

const OVERFLOW_PATTERN =
	/prompt is too long|input length exceeds context length|exceeds (the )?context (window|length)|context window exceeded|maximum context length/i;

const MANAGED_PROVIDERS = new Set(["ollama", "lmstudio"]);

/** Quick discovery pass so models are registered before pi finishes startup. */
async function discoverModels(
	providerId: string,
	fetcher: (context: RefreshModelsContext) => Promise<readonly Model<"openai-completions">[]>,
): Promise<Model<"openai-completions">[]> {
	try {
		return [
			...(await fetcher({
				allowNetwork: true,
				signal: AbortSignal.timeout(10000),
				credential: readStoredCredential(providerId) as any,
				publish: async () => false,
			})),
		];
	} catch {
		// Server not running / network blip: register empty; the next model
		// refresh (or /reload) fills the catalog.
		return [];
	}
}

export default async function lmProvidersExtension(pi: ExtensionAPI): Promise<void> {
	const [ollamaModels, lmStudioModels] = await Promise.all([
		discoverModels("ollama", ollamaFetchModels),
		discoverModels("lmstudio", lmStudioFetchModels),
	]);

	pi.registerProvider(
		createProvider({
			id: "ollama",
			name: "Ollama",
			auth: { apiKey: ollamaAuth() },
			models: ollamaModels,
			fetchModels: ollamaFetchModels,
			api: openAICompletionsApi(),
		}),
	);

	pi.registerProvider(
		createProvider({
			id: "lmstudio",
			name: "LM Studio",
			auth: { apiKey: lmStudioAuth() },
			models: lmStudioModels,
			fetchModels: lmStudioFetchModels,
			api: openAICompletionsApi(),
		}),
	);

	// Normalize server-side context overflow errors so pi can recover by
	// compacting the conversation and retrying (see custom-provider docs).
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		if (message.provider !== undefined && !MANAGED_PROVIDERS.has(message.provider)) return;
		if (message.provider === undefined && !MANAGED_PROVIDERS.has(ctx.model?.provider ?? "")) return;

		const errorMessage = message.errorMessage ?? "";
		if (errorMessage.includes("context_length_exceeded")) return;
		if (!OVERFLOW_PATTERN.test(errorMessage)) return;

		return {
			message: {
				...message,
				errorMessage: `context_length_exceeded: ${errorMessage}`,
			},
		};
	});
}
