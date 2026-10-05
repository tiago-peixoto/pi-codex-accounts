import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { asOpenAIContext, builtinOpenAIProvider, createAccountProvider, parseAccounts, withProvider } from "../src/index.ts";

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

test("accounts come from the config file, with one extra account by default", () => {
	assert.deepEqual(parseAccounts(undefined), [{ id: "openai-2", name: "OpenAI (2)" }]);
	assert.deepEqual(parseAccounts('{"accounts": [" Work ", "Side Gig"]}'), [
		{ id: "openai-work", name: "OpenAI (Work)" },
		{ id: "openai-side-gig", name: "OpenAI (Side Gig)" },
	]);
	assert.deepEqual(parseAccounts('{"accounts": []}'), []);
	for (const bad of ["{", "null", "[]", '{"accounts": "Work"}', '{"accounts": ["!!"]}', '{"accounts": ["Work", "work"]}']) {
		assert.throws(() => parseAccounts(bad), `should reject ${bad}`);
	}
});

test("an account is the built-in OpenAI provider under its own id and login name", () => {
	const openai = builtinOpenAIProvider();
	const provider = createAccountProvider(openai, { id: "openai-work", name: "OpenAI (Work)" });
	assert.equal(provider.id, "openai-work");
	assert.equal(provider.auth.oauth?.name, "OpenAI (Work)");
	assert.equal(provider.auth.apiKey, undefined);
	assert.deepEqual(
		provider.getModels().map((model) => model.id),
		openai.getModels().map((model) => model.id),
	);
	assert.ok(provider.getModels().every((model) => model.provider === "openai-work"));
});

test("only this account's replies count as the same conversation", () => {
	const context = asOpenAIContext(
		normalizeContext({ messages: [reply("openai-work"), reply("openai"), reply("openai-2")] }),
		"openai-work",
	);
	assert.deepEqual(
		context.messages.map((message) => (message.role === "assistant" ? message.provider : message.role)),
		["openai", "openai (another account)", "openai-2"],
	);
});

test("a request goes to the built-in provider as \"openai\" and its replies come back under the account id", async () => {
	const openai = builtinOpenAIProvider();
	const sent: string[] = [];
	const provider = createAccountProvider(
		{
			...openai,
			streamSimple: (model, context) => {
				sent.push(model.provider, ...context.messages.map((message) => (message.role === "assistant" ? message.provider : message.role)));
				const inner = createAssistantMessageEventStream();
				inner.push({ type: "done", reason: "stop", message: reply(model.provider) });
				inner.end();
				return inner;
			},
		},
		{ id: "openai-work", name: "OpenAI (Work)" },
	);
	const [model] = provider.getModels();
	assert.ok(model);
	const result = await provider.streamSimple(model, normalizeContext({ messages: [reply("openai-work")] })).result();
	assert.deepEqual(sent, ["openai", "openai"]);
	assert.equal(result.provider, "openai-work");
});

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
