/**
 * LM Studio provider (local server, also covers "LM Studio Bionic" — the new
 * LM Studio generation ships the same developer server on localhost:1234).
 *
 * Endpoint resolution:
 *   1. `/login lmstudio` (optional — only needed when the server requires an
 *      API token; by default LM Studio runs without authentication)
 *   2. Ambient environment variables:
 *        LMSTUDIO_BASE_URL   full base (default http://localhost:1234)
 *        LMSTUDIO_HOST, LMSTUDIO_PORT   host/port overrides
 *        LMSTUDIO_API_KEY or LM_API_TOKEN   server API token
 *
 * Model discovery: native GET /api/v1/models (type, capabilities, real
 * context window, loaded instance context), falling back to the
 * OpenAI-compatible GET /v1/models.
 */
import type {
	ApiKeyCredential,
	AuthCheck,
	AuthContext,
	AuthResult,
	Model,
	ProviderAuthInteraction,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { buildDynamicModel, fetchJson, guessReasoning, logRefresh, withTimeout } from "./shared.ts";

const DEFAULT_BASE = "http://localhost:1234";
const DUMMY_KEY = "lm-studio";

export interface LmStudioConfig {
	/** Server base without /v1. */
	base: string;
	apiKey?: string;
	source: string;
}

export function resolveLmStudioConfig(env: (name: string) => string | undefined): LmStudioConfig {
	let raw = env("LMSTUDIO_BASE_URL")?.trim() ?? "";
	if (!raw) {
		const host = env("LMSTUDIO_HOST")?.trim();
		const port = env("LMSTUDIO_PORT")?.trim();
		if (host) raw = host;
		else if (port) raw = `http://localhost:${port}`;
	}
	let base = raw || DEFAULT_BASE;
	if (!/^https?:\/\//i.test(base)) base = "http://" + base;
	base = base.replace(/\/+$/, "").replace(/\/v1$/i, "");
	const apiKey = env("LMSTUDIO_API_KEY") || env("LM_API_TOKEN") || undefined;
	return { base, apiKey, source: `LM Studio (${base})` };
}

async function configFromCtx(ctx: AuthContext, credential?: ApiKeyCredential): Promise<LmStudioConfig> {
	const names = ["LMSTUDIO_BASE_URL", "LMSTUDIO_HOST", "LMSTUDIO_PORT", "LMSTUDIO_API_KEY", "LM_API_TOKEN"];
	const values = await Promise.all(names.map((n) => ctx.env(n)));
	const ambient = new Map(names.map((n, i) => [n, values[i]]));
	const cfg = resolveLmStudioConfig((name) => credential?.env?.[name] ?? ambient.get(name) ?? process.env[name]);
	if (credential?.key && credential.key !== DUMMY_KEY) cfg.apiKey = credential.key;
	return cfg;
}

export function lmStudioAuth() {
	return {
		name: "LM Studio",

		async login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
			const choice = await interaction.prompt({
				type: "select",
				message: "How does your LM Studio server authenticate?",
				options: [
					{
						id: "none",
						label: "No authentication (default)",
						description: "LM Studio's developer server runs without auth unless you enabled a token.",
					},
					{
						id: "token",
						label: "API token",
						description: "Use when the server requires a Bearer token (Developer page → API tokens).",
					},
				],
			});

			if (choice === "token") {
				let key = "";
				while (!key.trim()) {
					key = await interaction.prompt({
						type: "secret",
						message: "LM Studio API token (Developer page → API tokens):",
					});
				}
				return { type: "api_key", key: key.trim() };
			}

			const cfg = resolveLmStudioConfig((name) => process.env[name]);
			interaction.notify({ type: "progress", message: `Checking ${cfg.base} …` });
			try {
				const res = await fetch(`${cfg.base}/api/v1/models`, { signal: withTimeout(interaction.signal, 3000) });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				interaction.notify({ type: "info", message: `Connected to ${cfg.base}.` });
			} catch {
				interaction.notify({
					type: "info",
					message: `Could not reach ${cfg.base} — start the server in LM Studio (Developer tab → Start Server) or with \`lms server start\`.`,
				});
			}
			return { type: "api_key", key: DUMMY_KEY };
		},

		async check({ ctx, credential }: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthCheck | undefined> {
			const cfg = await configFromCtx(ctx, credential);
			return { type: "api_key", source: cfg.source };
		},

		async resolve({ ctx, credential }: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthResult | undefined> {
			const cfg = await configFromCtx(ctx, credential);
			return {
				auth: { apiKey: cfg.apiKey ?? DUMMY_KEY, baseUrl: `${cfg.base}/v1` },
				source: cfg.apiKey ? "LM Studio API token" : cfg.source,
			};
		},
	};
}

interface LmStudioModelEntry {
	type?: string;
	key?: string;
	id?: string;
	display_name?: string;
	max_context_length?: number;
	loaded_instances?: Array<{ config?: { context_length?: number } }>;
	capabilities?: {
		vision?: boolean;
		trained_for_tool_use?: boolean;
		reasoning?: { allowed_options?: string[]; default?: string } | null;
	};
}

export async function lmStudioFetchModels(context: RefreshModelsContext): Promise<readonly Model<"openai-completions">[]> {
	if (!context.allowNetwork) throw new Error("LM Studio: network unavailable");

	const cfg = resolveLmStudioConfig((name) => context.credential?.env?.[name] ?? process.env[name]);
	if (context.credential?.key && context.credential.key !== DUMMY_KEY) cfg.apiKey = context.credential.key;

	const headers: Record<string, string> = {};
	if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

	const apiBase = `${cfg.base}/v1`;
	const models: Model<"openai-completions">[] = [];

	// 1) Native /api/v1/models — rich metadata (one retry on transient failures)
	let native: Awaited<ReturnType<typeof fetchJson<{ models?: LmStudioModelEntry }>>> | undefined;
	for (let attempt = 0; attempt < 2 && native === undefined; attempt++) {
		const result = await fetchJson<{ models?: LmStudioModelEntry[] }>(`${cfg.base}/api/v1/models`, {
			headers,
			signal: withTimeout(context.signal, 20000),
		});
		if (result.ok || context.signal.aborted || (result.status >= 400 && result.status < 500 && result.status !== 429)) {
			native = result;
		} else if (attempt === 0) {
			logRefresh("lmstudio", `/api/v1/models failed (${result.status || "network"} ${result.error}), retrying once`);
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}

	if (native?.ok && Array.isArray(native.body.models)) {
		for (const entry of native.body.models) {
			const id = entry.key ?? entry.id;
			if (!id) continue;
			if (entry.type && entry.type !== "llm") continue; // skip embedding models
			if (entry.capabilities?.trained_for_tool_use === false) continue; // pi needs tool calling
			// Prefer the context length of the loaded instance — LM Studio loads
			// models with a possibly smaller runtime context than the model maximum.
			const loadedContext = entry.loaded_instances?.find((i) => typeof i.config?.context_length === "number")?.config
				?.context_length;
			models.push(
				buildDynamicModel({
					id,
					name: entry.display_name || id,
					apiBase,
					provider: "lmstudio",
					reasoning: entry.capabilities?.reasoning != null,
					vision: entry.capabilities?.vision === true,
					contextWindow: loadedContext ?? entry.max_context_length,
				}),
			);
		}
		if (!models.length) {
			throw new Error(
				`LM Studio: no usable chat models at ${cfg.base} — download a tool-capable model in LM Studio (e.g. via the Discover tab).`,
			);
		}
		return models;
	}

	if (context.signal.aborted) throw new Error("LM Studio: aborted");

	// 2) Fallback: OpenAI-compatible listing (older servers)
	const list = await fetchJson<{ data?: Array<{ id?: string }> }>(`${apiBase}/models`, {
		headers,
		signal: withTimeout(context.signal, 20000),
	});
	if (!list.ok) {
		const message =
			`LM Studio: cannot list models at ${cfg.base} (${list.error}). ` +
			"Start the server in LM Studio (Developer tab) or with `lms server start`.";
		logRefresh("lmstudio", message);
		throw new Error(message);
	}
	for (const entry of list.body.data ?? []) {
		if (!entry.id) continue;
		models.push(
			buildDynamicModel({
				id: entry.id,
				apiBase,
				provider: "lmstudio",
				reasoning: guessReasoning(entry.id),
			}),
		);
	}
	if (!models.length) throw new Error(`LM Studio: no models found at ${cfg.base} — download one in LM Studio first.`);
	return models;
}
