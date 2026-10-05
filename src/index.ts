import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const OPENAI = "openai";
const CONFIG_FILE = "codex-accounts.json";

type OpenAIApi = "openai-responses";

export interface Account {
	id: string;
	name: string;
}

export default function codexAccounts(pi: ExtensionAPI) {
	const path = join(getAgentDir(), CONFIG_FILE);
	let accounts: Account[];
	try {
		accounts = parseAccounts(readConfig(path));
		// pi.registerProvider replaces a provider that has the same id, so the label "codex"
		// would silently take over pi's built-in "openai-codex" provider.
		const builtinIds = new Set(builtinProviders().map((provider) => provider.id));
		const taken = accounts.find((account) => builtinIds.has(account.id));
		if (taken) throw new Error(`the provider id "${taken.id}" belongs to a built-in pi provider; pick another label`);
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const openai = builtinOpenAIProvider();
	for (const account of accounts) pi.registerProvider(createAccountProvider(openai, account));
}

/** pi lets extensions import only a few pi-ai entry points; providers/all is the one with the built-in providers. */
export function builtinOpenAIProvider(): Provider<OpenAIApi> {
	const openai = builtinProviders().find((provider) => provider.id === OPENAI);
	if (!openai) throw new Error("pi no longer ships a built-in OpenAI provider");
	return openai as Provider<OpenAIApi>;
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
	const accounts = labels.map((label) => ({ id: `${OPENAI}-${slug(label)}`, name: `OpenAI (${label.trim()})` }));
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
 * The built-in OpenAI provider under another id, so pi keeps a separate ChatGPT login for it
 * and lists its models separately in /model.
 */
export function createAccountProvider(openai: Provider<OpenAIApi>, account: Account): Provider<OpenAIApi> {
	const oauth = openai.auth.oauth;
	if (!oauth) throw new Error("pi's built-in OpenAI provider does not offer Sign in with ChatGPT; update pi");
	const models = openai.getModels().map((model) => ({ ...model, provider: account.id }));
	return {
		id: account.id,
		name: account.name,
		baseUrl: openai.baseUrl,
		headers: openai.headers,
		// Only the login: the built-in provider's API key auth reads OPENAI_API_KEY,
		// which would resolve to the same key for every account.
		auth: { oauth: { ...oauth, name: account.name } },
		getModels: () => models,
		// pi-ai's Responses API recognises a ChatGPT login, and keeps Responses tool-call ids ("call|item")
		// intact, only when the model's provider is "openai", so requests go out under that id and
		// replies are relabelled.
		stream: (model, context, options) =>
			withProvider(openai.stream(asOpenAI(model), asOpenAIContext(context, account.id), options), account.id),
		streamSimple: (model, context, options) =>
			withProvider(openai.streamSimple(asOpenAI(model), asOpenAIContext(context, account.id), options), account.id),
	};
}

function asOpenAI<T extends OpenAIApi>(model: Model<T>): Model<T> {
	return { ...model, provider: OPENAI };
}

/**
 * Marks this account's earlier replies as "openai" so the Responses API treats them as the same
 * conversation. Replies from every other OpenAI account, the built-in one included, get a different id,
 * so their encrypted reasoning is dropped instead of being sent to this account.
 */
export function asOpenAIContext(context: TranscriptContext, accountId: string): TranscriptContext {
	return {
		...context,
		messages: context.messages.map((message) => {
			if (message.role !== "assistant") return message;
			if (message.provider === accountId) return { ...message, provider: OPENAI };
			if (message.provider === OPENAI) return { ...message, provider: `${OPENAI} (another account)` };
			return message;
		}),
	};
}

/** Copies each event with the account's id. The Responses API keeps using its own message objects, so they stay untouched. */
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
