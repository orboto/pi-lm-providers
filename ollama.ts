/**
 * Ollama provider: local server + Ollama Cloud in one.
 *
 * Endpoint resolution (in order):
 *   1. `/login ollama` choice, persisted with the credential:
 *        - "cloud" → https://ollama.com (API key from https://ollama.com/settings/keys)
 *        - "local" → local server (OLLAMA_HOST / OLLAMA_BASE_URL, default http://localhost:11434)
 *   2. Ambient environment variables (no login required):
 *        OLLAMA_MODE=cloud|local   force a mode
 *        OLLAMA_API_KEY=<key>      implies cloud when OLLAMA_MODE is unset
 *        OLLAMA_BASE_URL, OLLAMA_HOST, OLLAMA_CLOUD_BASE   endpoint overrides
 *
 * Model discovery: native /api/tags + /api/show (capabilities, real context
 * window), falling back to the OpenAI-compatible /v1/models. Models without
 * tool support are hidden — pi is an agent and cannot work without tools.
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
import { buildDynamicModel, fetchJson, forEachLimit, guessReasoning, logRefresh, withTimeout } from "./shared.ts";

const CLOUD_DEFAULT = "https://ollama.com";
const LOCAL_DEFAULT = "http://localhost:11434";
const DUMMY_KEY = "ollama";

export interface OllamaConfig {
	mode: "cloud" | "local";
	/** Server base without /v1 (native API root). */
	base: string;
	apiKey?: string;
	source: string;
}

/** Normalize an OLLAMA_HOST-style value ("127.0.0.1", "host:11434", "https://x.example") to a base URL. */
export function normalizeOllamaHost(raw: string | undefined): string | null {
	let v = (raw ?? "").trim();
	if (!v) return null;
	const hadScheme = /^https?:\/\//i.test(v);
	if (!hadScheme) v = "http://" + v;
	if (!hadScheme) {
		// bare host without a port gets the default Ollama port
		const rest = v.slice("http://".length);
		const hostPart = rest.split("/")[0];
		if (hostPart && !hostPart.includes(":")) v = `http://${hostPart}:11434${rest.slice(hostPart.length)}`;
	}
	v = v.replace(/\/+$/, "");
	v = v.replace(/\/(v1|api)$/i, "");
	return v || null;
}

export function resolveOllamaConfig(env: (name: string) => string | undefined): OllamaConfig {
	const modeEnv = env("OLLAMA_MODE");
	const apiKey = env("OLLAMA_API_KEY") || undefined;
	const mode: "cloud" | "local" = modeEnv === "cloud" ? "cloud" : modeEnv === "local" ? "local" : apiKey ? "cloud" : "local";
	const base =
		normalizeOllamaHost(env("OLLAMA_BASE_URL")) ??
		(mode === "local" ? normalizeOllamaHost(env("OLLAMA_HOST")) : null) ??
		normalizeOllamaHost(env("OLLAMA_CLOUD_BASE")) ??
		(mode === "cloud" ? CLOUD_DEFAULT : LOCAL_DEFAULT);
	return {
		mode,
		base,
		apiKey,
		source: mode === "cloud" ? "Ollama Cloud API key" : `local Ollama (${base})`,
	};
}

async function configFromCtx(ctx: AuthContext, credential?: ApiKeyCredential): Promise<OllamaConfig> {
	const names = ["OLLAMA_MODE", "OLLAMA_API_KEY", "OLLAMA_BASE_URL", "OLLAMA_HOST", "OLLAMA_CLOUD_BASE"];
	const values = await Promise.all(names.map((n) => ctx.env(n)));
	const ambient = new Map(names.map((n, i) => [n, values[i]]));
	const cfg = resolveOllamaConfig((name) => credential?.env?.[name] ?? ambient.get(name) ?? process.env[name]);
	// A stored credential key (e.g. the cloud API key) wins over ambient OLLAMA_API_KEY.
	if (credential?.key && !credential.env?.OLLAMA_API_KEY) cfg.apiKey = credential.key;
	return cfg;
}

export function ollamaAuth() {
	return {
		name: "Ollama",

		async login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
			const choice = await interaction.prompt({
				type: "select",
				message: "Which Ollama endpoint should pi use?",
				options: [
					{
						id: "cloud",
						label: "Ollama Cloud (ollama.com)",
						description: "Remote cloud models (gpt-oss, deepseek, qwen, glm, kimi, …). Requires an API key.",
					},
					{
						id: "local",
						label: "Local Ollama server",
						description: "Uses OLLAMA_HOST / OLLAMA_BASE_URL (default http://localhost:11434). No key required.",
					},
				],
			});

			if (choice === "cloud") {
				interaction.notify({
					type: "info",
					message: "Create an API key at https://ollama.com/settings/keys (Settings → API keys).",
					links: [{ url: "https://ollama.com/settings/keys", label: "ollama.com/settings/keys" }],
				});
				let key = "";
				while (!key.trim()) {
					key = await interaction.prompt({ type: "secret", message: "Ollama Cloud API key:" });
				}
				return { type: "api_key", key: key.trim(), env: { OLLAMA_MODE: "cloud" } };
			}

			// Local: no real key needed, but pi marks providers without auth as
			// unavailable, so we store the conventional dummy value.
			const cfg = resolveOllamaConfig((name) => process.env[name]);
			interaction.notify({ type: "progress", message: `Checking ${cfg.base} …` });
			try {
				const res = await fetch(`${cfg.base}/api/tags`, { signal: withTimeout(interaction.signal, 3000) });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				interaction.notify({ type: "info", message: `Connected to ${cfg.base}.` });
			} catch {
				interaction.notify({
					type: "info",
					message: `Could not reach ${cfg.base} — start it with \`ollama serve\`. Models will show up in /model once the server is running.`,
				});
			}
			return { type: "api_key", key: DUMMY_KEY, env: { OLLAMA_MODE: "local" } };
		},

		async check({ ctx, credential }: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthCheck | undefined> {
			const cfg = await configFromCtx(ctx, credential);
			if (cfg.mode === "cloud" && !cfg.apiKey) return undefined;
			return { type: "api_key", source: cfg.source };
		},

		async resolve({ ctx, credential }: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthResult | undefined> {
			const cfg = await configFromCtx(ctx, credential);
			if (cfg.mode === "cloud" && !cfg.apiKey) return undefined;
			return {
				auth: { apiKey: cfg.apiKey ?? DUMMY_KEY, baseUrl: `${cfg.base}/v1` },
				source: cfg.source,
			};
		},
	};
}

interface ShowDetails {
	capabilities: string[];
	contextLength?: number;
}

/** Cache /api/show results for 10 minutes — the answer never changes within a session. */
const showCache = new Map<string, { details: ShowDetails; expires: number }>();
const SHOW_CACHE_TTL_MS = 10 * 60 * 1000;

async function showModel(base: string, name: string, headers: Record<string, string>, signal: AbortSignal): Promise<ShowDetails | null> {
	const cacheKey = `${base}|${name}`;
	const cached = showCache.get(cacheKey);
	if (cached && cached.expires > Date.now()) return cached.details;

	const result = await fetchJson<{ capabilities?: string[]; model_info?: Record<string, unknown> }>(`${base}/api/show`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({ model: name }),
		signal: withTimeout(signal, 15000),
	});
	if (!result.ok) return null;
	const contextEntry = Object.entries(result.body.model_info ?? {}).find(([key]) => key.endsWith(".context_length"));
	const details: ShowDetails = {
		capabilities: result.body.capabilities ?? [],
		contextLength: typeof contextEntry?.[1] === "number" ? contextEntry[1] : undefined,
	};
	showCache.set(cacheKey, { details, expires: Date.now() + SHOW_CACHE_TTL_MS });
	return details;
}

export async function ollamaFetchModels(context: RefreshModelsContext): Promise<readonly Model<"openai-completions">[]> {
	if (!context.allowNetwork) throw new Error("Ollama: network unavailable");

	const cfg = resolveOllamaConfig((name) => context.credential?.env?.[name] ?? process.env[name]);
	if (cfg.mode === "cloud" && context.credential?.key && !context.credential.env?.OLLAMA_API_KEY) {
		cfg.apiKey = context.credential.key;
	}

	const headers: Record<string, string> = {};
	const apiKey = cfg.mode === "cloud" ? cfg.apiKey : undefined; // local servers don't want our dummy key
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	// 1) Native /api/tags (model names) — one retry on transient failures
	let names: string[] | undefined;
	let native = false;
	for (let attempt = 0; attempt < 2 && names === undefined; attempt++) {
		const tags = await fetchJson<{ models?: Array<{ name?: string; model?: string }> }>(`${cfg.base}/api/tags`, {
			headers,
			signal: withTimeout(context.signal, 20000),
		});
		if (tags.ok) {
			names = (tags.body.models ?? [])
				.map((m) => m.name ?? m.model ?? "")
				.filter((n): n is string => Boolean(n));
			native = true;
		} else if (context.signal.aborted || (tags.status >= 400 && tags.status < 500 && tags.status !== 429)) {
			break; // aborted or a permanent client error (e.g. 401/404) — retrying won't help
		} else if (attempt === 0) {
			logRefresh("ollama", `/api/tags failed (${tags.status || "network"} ${tags.error}), retrying once`);
			await new Promise((resolve) => setTimeout(resolve, 600));
		}
	}
	if (context.signal.aborted) throw new Error("Ollama: aborted");

	// 2) Fallback: OpenAI-compatible listing
	if (!names) {
		const list = await fetchJson<{ data?: Array<{ id?: string }> }>(`${cfg.base}/v1/models`, {
			headers,
			signal: withTimeout(context.signal, 20000),
		});
		if (!list.ok) {
			const message =
				`Ollama: cannot list models at ${cfg.base} (${list.error}). ` +
				(cfg.mode === "cloud"
					? "Run /login ollama to store an API key."
					: "Start the server with `ollama serve` and pull a model with `ollama pull <model>`, or unset OLLAMA_MODE/local config if you meant Ollama Cloud.");
			logRefresh("ollama", message);
			throw new Error(message);
		}
		names = (list.body.data ?? [])
			.map((m) => m.id ?? "")
			.filter((n): n is string => Boolean(n));
	}

	if (!names.length) {
		throw new Error(
			`Ollama: no models found at ${cfg.base}` +
				(cfg.mode === "local" ? " — download one with `ollama pull <model>`." : " — check your account at ollama.com."),
		);
	}

	// 3) Enrich with capabilities + real context windows via /api/show
	const details = new Map<string, ShowDetails>();
	if (native) {
		await forEachLimit(names, 6, async (name) => {
			const detail = await showModel(cfg.base, name, headers, context.signal);
			if (detail) details.set(name, detail);
		});
	}

	const apiBase = `${cfg.base}/v1`;
	const models: Model<"openai-completions">[] = [];
	for (const id of names) {
		const detail = details.get(id);
		if (detail && !detail.capabilities.includes("tools")) continue; // pi needs tool calling
		models.push(
			buildDynamicModel({
				id,
				apiBase,
				provider: "ollama",
				reasoning: detail ? detail.capabilities.includes("thinking") : guessReasoning(id),
				vision: detail ? detail.capabilities.includes("vision") : false,
				contextWindow: detail?.contextLength,
			}),
		);
	}
	return models;
}
