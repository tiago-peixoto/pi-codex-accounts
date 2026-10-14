import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	normalizeContext,
	type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	type Account,
	type AccountApi,
	accountProviders,
	asBuiltinContext,
	createAccountProvider,
	parseAccounts,
	withProvider,
} from "../src/index.ts";

const builtinIds = new Set(builtinProviders().map((provider) => provider.id));

function builtin(id: string): Provider<AccountApi> {
	const provider = builtinProviders().find((provider) => provider.id === id);
	assert.ok(provider, `pi should ship a built-in "${id}" provider`);
	return provider as Provider<AccountApi>;
}

const work: Record<string, Account> = {
	openai: { builtin: "openai", id: "openai-work", name: "OpenAI (Work)" },
	"openai-codex": { builtin: "openai-codex", id: "openai-codex-work", name: "OpenAI Codex (Work)" },
};

function reply(provider: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider,
		model: "gpt-6.1-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function providerOf(event: AssistantMessageEvent): string {
	if (event.type === "done") return event.message.provider;
	if (event.type === "error") return event.error.provider;
	return event.partial.provider;
}

test("each label gives a Sign in with ChatGPT account and a Codex OAuth account, with one label by default", () => {
	assert.deepEqual(parseAccounts(undefined, builtinIds), [
		{ builtin: "openai", id: "openai-2", name: "OpenAI (2)" },
		{ builtin: "openai-codex", id: "openai-codex-2", name: "OpenAI Codex (2)" },
	]);
	assert.deepEqual(parseAccounts('{"accounts": [" Work ", "Side Gig"]}', builtinIds), [
		{ builtin: "openai", id: "openai-work", name: "OpenAI (Work)" },
		{ builtin: "openai-codex", id: "openai-codex-work", name: "OpenAI Codex (Work)" },
		{ builtin: "openai", id: "openai-side-gig", name: "OpenAI (Side Gig)" },
		{ builtin: "openai-codex", id: "openai-codex-side-gig", name: "OpenAI Codex (Side Gig)" },
	]);
	assert.deepEqual(parseAccounts('{"accounts": []}', builtinIds), []);
	for (const bad of [
		"{",
		"null",
		"[]",
		'{"accounts": "Work"}',
		'{"accounts": ["!!"]}',
		'{"accounts": ["Work", "work"]}',
		'{"accounts": ["work", "codex-work"]}',
	]) {
		assert.throws(() => parseAccounts(bad, builtinIds), `should reject ${bad}`);
	}
});

test("a label is rejected when either of its ids belongs to a built-in provider", () => {
	assert.throws(() => parseAccounts('{"accounts": ["codex"]}', builtinIds), /"openai-codex" belongs to a built-in/);
	assert.throws(() => parseAccounts('{"accounts": ["work"]}', new Set(["openai-codex-work"])), /"openai-codex-work" belongs to a built-in/);
	assert.doesNotThrow(() => parseAccounts('{"accounts": ["work"]}', new Set(["openai", "openai-codex"])));
});

test("an account is the built-in OpenAI provider under its own id and login name", () => {
	const openai = builtin("openai");
	const provider = createAccountProvider(openai, work.openai);
	assert.equal(provider.id, "openai-work");
	assert.equal(provider.auth.oauth?.name, "OpenAI (Work)");
	assert.equal(provider.auth.apiKey, undefined);
	assert.deepEqual(
		provider.getModels().map((model) => model.id),
		openai.getModels().map((model) => model.id),
	);
	assert.ok(provider.getModels().every((model) => model.provider === "openai-work"));
});

test("a Codex account is the built-in Codex provider under its own id, with its base URL and API", () => {
	const codex = builtin("openai-codex");
	const provider = createAccountProvider(codex, work["openai-codex"]);
	assert.equal(provider.id, "openai-codex-work");
	assert.equal(provider.auth.oauth?.name, "OpenAI Codex (Work)");
	assert.equal(provider.auth.apiKey, undefined);
	assert.equal(provider.baseUrl, codex.baseUrl);
	assert.notEqual(provider.baseUrl, builtin("openai").baseUrl);
	assert.deepEqual(
		provider.getModels().map((model) => model.id),
		codex.getModels().map((model) => model.id),
	);
	assert.ok(provider.getModels().every((model) => model.provider === "openai-codex-work" && model.api === "openai-codex-responses"));
});

test("a pi without the legacy Codex provider still gets the Sign in with ChatGPT account", () => {
	const accounts = parseAccounts('{"accounts": ["work"]}', builtinIds);
	const ids = (providers: readonly Provider[]) => accountProviders(providers, accounts).map((provider) => provider.id);
	assert.deepEqual(ids(builtinProviders()), ["openai-work", "openai-codex-work"]);
	assert.deepEqual(ids(builtinProviders().filter((provider) => provider.id !== "openai-codex")), ["openai-work"]);
	assert.throws(() => ids(builtinProviders().filter((provider) => provider.id !== "openai")), /OpenAI provider/);
});

test("only this account's replies count as the same conversation", () => {
	const context = normalizeContext({
		messages: [reply("openai-work"), reply("openai"), reply("openai-2"), reply("openai-codex-work"), reply("openai-codex")],
	});
	const providers = (builtinId: string, accountId: string) =>
		asBuiltinContext(context, builtinId, accountId).messages.map((message) => (message.role === "assistant" ? message.provider : message.role));
	assert.deepEqual(providers("openai", "openai-work"), [
		"openai",
		"openai (another account)",
		"openai-2",
		"openai-codex-work",
		"openai-codex",
	]);
	assert.deepEqual(providers("openai-codex", "openai-codex-work"), [
		"openai-work",
		"openai",
		"openai-2",
		"openai-codex",
		"openai-codex (another account)",
	]);
});

for (const builtinId of ["openai", "openai-codex"]) {
	test(`a request goes to the built-in provider as "${builtinId}" and its replies come back under the account id`, async () => {
		const account = work[builtinId];
		const sent: string[] = [];
		const provider = createAccountProvider(
			{
				...builtin(builtinId),
				streamSimple: (model, context) => {
					sent.push(model.provider, ...context.messages.map((message) => (message.role === "assistant" ? message.provider : message.role)));
					const inner = createAssistantMessageEventStream();
					inner.push({ type: "done", reason: "stop", message: reply(model.provider) });
					inner.end();
					return inner;
				},
			},
			account,
		);
		const [model] = provider.getModels();
		assert.ok(model);
		const result = await provider.streamSimple(model, normalizeContext({ messages: [reply(account.id)] })).result();
		assert.deepEqual(sent, [builtinId, builtinId]);
		assert.equal(result.provider, account.id);
	});
}

test("streamed replies carry the account id and leave the Responses API objects untouched", async () => {
	const inner = createAssistantMessageEventStream();
	const message = reply("openai");
	const outer = withProvider(inner, "openai-work");
	inner.push({ type: "start", partial: message });
	inner.push({ type: "done", reason: "stop", message });

	const providers: string[] = [];
	for await (const event of outer) providers.push(providerOf(event));

	assert.deepEqual(providers, ["openai-work", "openai-work"]);
	assert.equal((await outer.result()).provider, "openai-work");
	assert.equal(message.provider, "openai");
});
