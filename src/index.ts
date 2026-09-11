import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const CODEX = "openai-codex";
const CONFIG_FILE = "codex-accounts.json";

type CodexApi = "openai-codex-responses";

export interface Account {
	id: string;
	name: string;
}

export default function codexAccounts(pi: ExtensionAPI) {
	const path = join(getAgentDir(), CONFIG_FILE);
	let accounts: Account[];
	try {
		accounts = parseAccounts(readConfig(path));
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const codex = openaiCodexProvider();
	for (const account of accounts) pi.registerProvider(createAccountProvider(codex, account));
}

/** The config file's text, or undefined when there is no config file. */
function readConfig(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Without a config file there is one extra account, labelled "2". */
export function parseAccounts(json: string | undefined): Account[] {
	const labels = json === undefined ? ["2"] : readLabels(json);
	const accounts = labels.map((label) => ({ id: `${CODEX}-${slug(label)}`, name: `OpenAI Codex (${label.trim()})` }));
	const seen = new Set<string>();
	for (const { id } of accounts) {
		if (seen.has(id)) throw new Error(`two labels turn into the same provider id "${id}"`);
		seen.add(id);
	}
	return accounts;
}

function readLabels(json: string): string[] {
	const labels = (JSON.parse(json) as { accounts?: unknown } | null)?.accounts;
	if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string" && slug(label) !== "")) {
		throw new Error('expected {"accounts": ["Work", "Personal"]}, with an ASCII letter or digit in each label');
	}
	return labels;
}

function slug(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The built-in Codex provider under another id, so pi keeps a separate login for it
 * and lists its models separately in /model.
 */
export function createAccountProvider(codex: Provider<CodexApi>, account: Account): Provider<CodexApi> {
	const oauth = codex.auth.oauth;
	if (!oauth) throw new Error("pi's built-in OpenAI Codex provider no longer offers a ChatGPT login");
	const models = codex.getModels().map((model) => ({ ...model, provider: account.id }));
	return {
		id: account.id,
		name: account.name,
		baseUrl: codex.baseUrl,
		headers: codex.headers,
		// Only the login: any other auth the built-in provider may gain (an environment variable, say)
		// would resolve to the built-in account instead of this one.
		auth: { oauth: { ...oauth, name: account.name } },
		getModels: () => models,
		// pi-ai's Codex API keeps Responses tool-call ids ("call|item") intact only when the model's
		// provider is "openai-codex", so requests go out under that id and replies are relabelled.
		stream: (model, context, options) =>
			withProvider(codex.stream(asCodex(model), asCodexContext(context, account.id), options), account.id),
		streamSimple: (model, context, options) =>
			withProvider(codex.streamSimple(asCodex(model), asCodexContext(context, account.id), options), account.id),
	};
}

function asCodex<T extends CodexApi>(model: Model<T>): Model<T> {
	return { ...model, provider: CODEX };
}

/**
 * Marks this account's earlier replies as "openai-codex" so the Codex API treats them as the same
 * conversation. Replies from every other Codex account, the built-in one included, get a different id,
 * so their encrypted reasoning is dropped instead of being sent to this account.
 */
export function asCodexContext(context: Context, accountId: string): Context {
	return {
		...context,
		messages: context.messages.map((message) => {
			if (message.role !== "assistant") return message;
			if (message.provider === accountId) return { ...message, provider: CODEX };
			if (message.provider === CODEX) return { ...message, provider: `${CODEX} (another account)` };
			return message;
		}),
	};
}

/** Copies each event with the account's id. The Codex API keeps using its own message objects, so they stay untouched. */
export function withProvider(inner: AssistantMessageEventStream, provider: string): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of inner) outer.push(relabel(event, provider));
		outer.end();
	})();
	return outer;
}

function relabel(event: AssistantMessageEvent, provider: string): AssistantMessageEvent {
	switch (event.type) {
		case "done":
			return { ...event, message: { ...event.message, provider } };
		case "error":
			return { ...event, error: { ...event.error, provider } };
		default:
			return { ...event, partial: { ...event.partial, provider } };
	}
}
