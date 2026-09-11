# pi-codex-accounts

Use more than one ChatGPT (Codex) subscription in [pi](https://pi.dev), each with its own login and its own entries in `/model`.

pi's built-in OpenAI Codex provider holds one login.
This extension adds providers that work exactly like it, so a second (or third) ChatGPT account can stay signed in next to the first:

```text
gpt-5.6-sol [openai-codex]
gpt-5.6-sol [openai-codex-2]
```

It never switches accounts on its own.
You choose the account whenever you choose a model.

## Install

```sh
pi install npm:pi-codex-accounts
```

Then run `/login`, choose **Sign in with an account**, pick **OpenAI Codex (2)**, and sign in with your other ChatGPT account.
Your browser may reuse the ChatGPT account it is already signed into, so use a private window or the device-code option.

## More accounts or other names

Create `~/.pi/agent/codex-accounts.json` and restart pi:

```json
{ "accounts": ["Work", "Personal"] }
```

Each label becomes a provider: `Work` shows up as **OpenAI Codex (Work)** with the id `openai-codex-work`.
Without the file you get one extra account, `openai-codex-2`.
An empty list adds none.
pi stores logins under the provider id, so renaming a label means signing in again.

## How it works

Each account reuses pi's own Codex login flow, model list, and request code, so it behaves like the built-in provider and picks up new Codex models when pi updates.
pi keeps each login in `~/.pi/agent/auth.json` under the account's provider id, and requests use that login's token.

Two details keep accounts apart:

- pi-ai's Codex code keeps Responses tool-call ids intact only for the provider id `openai-codex`, so requests go out under that id and replies are relabelled with the account's id.
- Replies from a different Codex account in the same session count as another provider's, so their encrypted reasoning is dropped instead of being sent to this account.

The extension never copies tokens into environment variables, so commands the agent runs cannot read them.

Tested with pi 0.85.1.

## Development

```sh
npm install
npm test
```

Releases are built by GitHub Actions and published with npm trusted publishing, so every version on npm links back to the commit it was built from.
