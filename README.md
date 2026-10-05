```text
              __                                      __
 _______  ___/ /____ __  ___ ____________  __ _____  / /____
/ __/ _ \/ _  / -_) \ / / _ `/ __/ __/ _ \/ // / _ \/ __(_-<
\__/\___/\_,_/\__/_\_\  \_,_/\__/\__/\___/\_,_/_//_/\__/___/

          [ work ]   <-- /model -->   [ personal ]
```

**pi-codex-accounts** keeps your work and personal ChatGPT accounts signed in to [pi](https://pi.dev), side by side.

pi's built-in OpenAI provider holds one ChatGPT login.
If you use one account at work and another for your own projects, switching means logging out and back in every time.
This little extension gives each account its own login and its own models in `/model`, so switching is just picking a model.

```text
gpt-6.1-sol [openai]        your personal account (pi's built-in provider)
gpt-6.1-sol [openai-work]   your work account
```

## Install

```sh
pi install npm:pi-codex-accounts
```

## Set it up

1. Name your extra account in `~/.pi/agent/codex-accounts.json`:

   ```json
   { "accounts": ["work"] }
   ```

2. Restart pi, run `/login`, choose **Sign in with an account**, and pick **OpenAI (work)**.
3. Sign in with your work ChatGPT account.
   A private browser window helps, so the browser doesn't reuse the account it is already signed into.
4. Open `/model` and pick any `[openai-work]` model.

## The accounts file

Each label becomes its own account: `"work"` shows up as **OpenAI (work)**, with the provider id `openai-work`.
If you have more than one work account, for example one per client, list them all: `{ "accounts": ["work", "client"] }`.
Without the file you get one extra account, labelled `2`.
The label `codex` is not allowed, because its provider id `openai-codex` belongs to pi's legacy Codex provider.

pi saves each login under the provider id, so renaming a label means signing in again.
The old login stays listed in `/logout` under its old id, and you can remove it from there.

## Upgrading from 0.1

Version 0.1 copied pi's OpenAI Codex provider, which pi now calls legacy.
This version copies pi's OpenAI provider and its **Sign in with ChatGPT** login instead, so it needs pi 1.0 or newer.
The provider ids changed from `openai-codex-work` to `openai-work`, so sign in to each account once more.
The accounts file keeps its name and its format.

## How it works

Each account is pi's own OpenAI provider under a new id: the same Sign in with ChatGPT flow, the same models, and the same request code.
It behaves like the built-in provider and picks up new OpenAI models whenever pi updates.

Accounts stay separate.
Each one has its own saved login, and when you switch accounts in the middle of a conversation, one account's encrypted reasoning is never sent to another.

Your tokens stay in pi's `auth.json`.
The extension never copies them into environment variables, so commands the agent runs can't read them.

Tested with pi 1.0.3.

## Development

```sh
npm install
npm test
```

`npm test` runs the type check, the unit tests, and a smoke test that installs the packed package into pi the way `pi install` does.
Releases are built on GitHub Actions and published with npm trusted publishing, so every version on npm links back to the commit it came from.

## License

MIT
