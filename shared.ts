/**
 * Shared helpers for the dynamically discovered local/cloud LLM providers
 * (ollama, lmstudio). All of them speak the OpenAI Chat Completions API.
 */
import type { Model } from "@earendil-works/pi-ai";

/**
 * Compat settings that are safe across Ollama / LM Studio style servers:
 * - `system` role instead of `developer`
 * - no `reasoning_effort` passthrough (servers auto-think by default)
 * - legacy `max_tokens` field
 */
export const localCompat = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens" as const,
	supportsStrictMode: false,
	// LM Studio rejects unknown request fields ("Extra inputs are not permitted")
	// and neither server implements OpenAI response storage.
	supportsStore: false,
};

export interface DynamicModelInput {
	/** Model id sent as the `model` request field. */
	id: string;
	/** Display name shown in /model. Defaults to id. */
	name?: string;
	/** API base including /v1 (OpenAI-compatible endpoint). */
	apiBase: string;
	/** Provider id the model belongs to. */
	provider: string;
	reasoning: boolean;
	vision?: boolean;
	/** Known context window in tokens. Falls back to 32768 when unknown. */
	contextWindow?: number;
	/** Cap for maxTokens. Default 65536. */
	maxTokensCap?: number;
}

export function buildDynamicModel(input: DynamicModelInput): Model<"openai-completions"> {
	const contextWindow = Math.max(2048, Math.floor(input.contextWindow ?? 0) > 0 ? input.contextWindow! : 32768);
	return {
		id: input.id,
		name: input.name ?? input.id,
		api: "openai-completions",
		provider: input.provider,
		baseUrl: input.apiBase,
		reasoning: input.reasoning,
		input: input.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.max(2048, Math.min(Math.floor(contextWindow / 2), input.maxTokensCap ?? 65536)),
		compat: { ...localCompat },
	};
}

/** Run fn over items with at most `limit` concurrent promises; preserves order, rejects on first error. */
export async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			await fn(items[index]);
		}
	});
	await Promise.all(workers);
}

/** Fetch helper that turns network failures into readable provider errors. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ ok: true; body: T } | { ok: false; status: number; error: string }> {
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch (error) {
		return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
	}
	if (!res.ok) {
		return { ok: false, status: res.status, error: `HTTP ${res.status} ${res.statusText}`.trim() };
	}
	try {
		return { ok: true, body: (await res.json()) as T };
	} catch (error) {
		return { ok: false, status: res.status, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Combine the refresh signal with a per-request timeout (Node >= 20.3 has AbortSignal.any). */
export function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return typeof (AbortSignal as any).any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

/** Reasoning heuristic used when a server gives us only model names (no capabilities). */
export function guessReasoning(id: string): boolean {
	return /gpt-oss|deepseek-r1|deepseek-v3\.1|deepseek-v4|qwen3|qwq|[-_.]r1\b|thinking|reasoner|glm-[45]\.5|glm-5|kimi-k3|magistral|minimax-m[23]|nemotron-3/i.test(
		id,
	);
}
