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
const CODEX = "openai-codex";
const CONFIG_FILE = "codex-accounts.json";

/** The built-in providers each label copies, and the name each copy shows in /login. */
const BUILTINS = [
	{ id: OPENAI, name: "OpenAI" },
	{ id: CODEX, name: "OpenAI Codex" },
];

export type AccountApi = "openai-responses" | "openai-codex-responses";

export interface Account {
	/** The id of the built-in provider this account copies. */
	builtin: string;
	id: string;
	name: string;
}

export default function codexAccounts(pi: ExtensionAPI) {
	const path = join(getAgentDir(), CONFIG_FILE);
	// pi lets extensions import only a few pi-ai entry points; providers/all is the one with the built-in providers.
	const builtins = builtinProviders();
	let accounts: Account[];
	try {
		accounts = parseAccounts(readConfig(path), new Set(builtins.map((provider) => provider.id)));
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (const provider of accountProviders(builtins, accounts)) pi.registerProvider(provider);
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

/**
 * One account per built-in provider for each label. Without a config file there is one label, "2".
 * pi.registerProvider replaces a provider that has the same id, so an id that belongs to a built-in
 * provider is rejected: the label "codex" would silently take over pi's "openai-codex".
 */
export function parseAccounts(json: string | undefined, builtinIds: ReadonlySet<string>): Account[] {
	const labels = json === undefined ? ["2"] : readLabels(json);
	const accounts = labels.flatMap((label) =>
		BUILTINS.map((builtin) => ({
			builtin: builtin.id,
			id: `${builtin.id}-${slug(label)}`,
			name: `${builtin.name} (${label.trim()})`,
		})),
	);
	const seen = new Set<string>();
	for (const { id } of accounts) {
		if (builtinIds.has(id)) throw new Error(`the provider id "${id}" belongs to a built-in pi provider; pick another label`);
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
 * The providers to register. pi calls its Codex provider legacy, so a pi that has dropped it
 * still gets each label's Sign in with ChatGPT account.
 */
export function accountProviders(builtins: readonly Provider[], accounts: Account[]): Provider<AccountApi>[] {
	return accounts.flatMap((account) => {
		const builtin = builtins.find((provider) => provider.id === account.builtin);
		if (builtin) return [createAccountProvider(builtin as Provider<AccountApi>, account)];
		if (account.builtin === CODEX) return [];
		throw new Error("pi no longer ships a built-in OpenAI provider");
	});
}

/**
 * A built-in provider under another id, so pi keeps a separate login for it
 * and lists its models separately in /model.
 */
export function createAccountProvider<A extends AccountApi>(builtin: Provider<A>, account: Account): Provider<A> {
	const oauth = builtin.auth.oauth;
	if (!oauth) throw new Error(`pi's built-in ${builtin.name} provider does not offer a ChatGPT login; update pi`);
	const models = builtin.getModels().map((model) => ({ ...model, provider: account.id }));
	return {
		id: account.id,
		name: account.name,
		baseUrl: builtin.baseUrl,
		headers: builtin.headers,
		// Only the login: the built-in OpenAI provider's API key auth reads OPENAI_API_KEY,
		// which would resolve to the same key for every account.
		auth: { oauth: { ...oauth, name: account.name } },
		getModels: () => models,
		// pi-ai's Responses APIs recognise a ChatGPT login, and keep Responses tool-call ids ("call|item")
		// intact, only when the model's provider is the built-in's id, so requests go out under that id and
		// replies are relabelled.
		stream: (model, context, options) =>
			withProvider(builtin.stream(asBuiltin(model, builtin.id), asBuiltinContext(context, builtin.id, account.id), options), account.id),
		streamSimple: (model, context, options) =>
			withProvider(builtin.streamSimple(asBuiltin(model, builtin.id), asBuiltinContext(context, builtin.id, account.id), options), account.id),
	};
}

function asBuiltin<A extends AccountApi>(model: Model<A>, builtinId: string): Model<A> {
	return { ...model, provider: builtinId };
}

/**
 * Marks this account's earlier replies as the built-in's so its API treats them as the same
 * conversation. Replies from every other account of that built-in, the built-in itself included, get
 * a different id, so their encrypted reasoning is dropped instead of being sent to this account.
 */
export function asBuiltinContext(context: TranscriptContext, builtinId: string, accountId: string): TranscriptContext {
	return {
		...context,
		messages: context.messages.map((message) => {
			if (message.role !== "assistant") return message;
			if (message.provider === accountId) return { ...message, provider: builtinId };
			if (message.provider === builtinId) return { ...message, provider: `${builtinId} (another account)` };
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
