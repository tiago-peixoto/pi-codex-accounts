import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssistantMessage, type AssistantMessageEvent, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { asCodexContext, builtinCodexProvider, createAccountProvider, parseAccounts, withProvider } from "../src/index.ts";

function reply(provider: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider,
		model: "gpt-5.6-sol",
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
	assert.deepEqual(parseAccounts(undefined), [{ id: "openai-codex-2", name: "OpenAI Codex (2)" }]);
	assert.deepEqual(parseAccounts('{"accounts": [" Work ", "Side Gig"]}'), [
		{ id: "openai-codex-work", name: "OpenAI Codex (Work)" },
		{ id: "openai-codex-side-gig", name: "OpenAI Codex (Side Gig)" },
	]);
	assert.deepEqual(parseAccounts('{"accounts": []}'), []);
	for (const bad of ["{", "null", "[]", '{"accounts": "Work"}', '{"accounts": ["!!"]}', '{"accounts": ["Work", "work"]}']) {
		assert.throws(() => parseAccounts(bad), `should reject ${bad}`);
	}
});

test("an account is the built-in Codex provider under its own id and login name", () => {
	const codex = builtinCodexProvider();
	const provider = createAccountProvider(codex, { id: "openai-codex-work", name: "OpenAI Codex (Work)" });
	assert.equal(provider.id, "openai-codex-work");
	assert.equal(provider.auth.oauth?.name, "OpenAI Codex (Work)");
	assert.equal(provider.auth.apiKey, undefined);
	assert.deepEqual(
		provider.getModels().map((model) => model.id),
		codex.getModels().map((model) => model.id),
	);
	assert.ok(provider.getModels().every((model) => model.provider === "openai-codex-work"));
});

test("only this account's replies count as the same conversation", () => {
	const context = asCodexContext(
		{ messages: [reply("openai-codex-work"), reply("openai-codex"), reply("openai-codex-2")] },
		"openai-codex-work",
	);
	assert.deepEqual(
		context.messages.map((message) => (message.role === "assistant" ? message.provider : message.role)),
		["openai-codex", "openai-codex (another account)", "openai-codex-2"],
	);
});

test("streamed replies carry the account id and leave the Codex objects untouched", async () => {
	const inner = createAssistantMessageEventStream();
	const message = reply("openai-codex");
	const outer = withProvider(inner, "openai-codex-work");
	inner.push({ type: "start", partial: message });
	inner.push({ type: "done", reason: "stop", message });

	const providers: string[] = [];
	for await (const event of outer) providers.push(providerOf(event));

	assert.deepEqual(providers, ["openai-codex-work", "openai-codex-work"]);
	assert.equal((await outer.result()).provider, "openai-codex-work");
	assert.equal(message.provider, "openai-codex");
});
