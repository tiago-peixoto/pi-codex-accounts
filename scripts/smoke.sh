#!/bin/sh
# Loads the packed package the way `pi install npm:...` does: without node_modules of its own,
# so its pi-ai and pi-coding-agent imports must resolve to the copies pi ships.
set -eu

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pi="$PWD/node_modules/.bin/pi"

npm pack --pack-destination "$tmp" >/dev/null 2>&1
tar -xzf "$tmp"/pi-codex-accounts-*.tgz -C "$tmp"

export PI_CODING_AGENT_DIR="$tmp/agent"
mkdir -p "$PI_CODING_AGENT_DIR"
# The login is expired and has no client id, so pi must refresh it before a request,
# and the refresh fails before any network call.
printf '%s' '{"openai-2": {"type": "oauth", "refresh": "x", "access": "x", "expires": 0}}' \
	>"$PI_CODING_AGENT_DIR/auth.json"
chmod 600 "$PI_CODING_AGENT_DIR/auth.json"
"$pi" install "$tmp/package" >/dev/null

# --list-models skips extensions that fail to load, so check that the account's models show up.
model=$("$pi" --list-models openai-2 </dev/null | awk '$1 == "openai-2" { print $2; exit }')
if [ -z "$model" ]; then
	echo "smoke: the packed extension did not register openai-2" >&2
	"$pi" -p --no-session --provider openai-2 --model any hi </dev/null >&2 || true
	exit 1
fi
echo "smoke: the packed extension registers openai-2"

out=$("$pi" -p --no-session --provider openai-2 --model "$model" hi </dev/null 2>&1 || true)
case $out in
*"refresh failed for openai-2"*"reconnect ChatGPT"*) echo "smoke: a request uses the account's own ChatGPT login" ;;
*)
	printf 'smoke: unexpected request result:\n%s\n' "$out" >&2
	exit 1
	;;
esac
