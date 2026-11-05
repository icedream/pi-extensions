#!/bin/sh
# Proof for pi-commit-attribution: the paths a commit can take, and what the attribution does on each.
#
# Every case here was first checked by hand against git 2.56 before the extension was written, and this
# script is that table kept running. It installs the same hook farm a session installs, points git at it
# through GIT_CONFIG_* the way the session's environment does, and asserts on the resulting commit
# messages. A repository is never left with anything in it: the farm lives in a temporary directory.
#
# Run with: sh commit-paths.test.sh

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pi-attribution-proof.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

PASS=0
FAIL=0
NOTE=""

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n%s\n' "$1" "${2:+     $2}"; }

# ---------------------------------------------------------------- fixtures

HOME_DIR="$WORK/home"
FARM="$HOME_DIR/hooks"
CONFIG="$WORK/attribution.json"
MODELS="$WORK/models.json"
mkdir -p "$HOME_DIR"

cat >"$MODELS" <<'JSON'
{
  "providers": {
    "test-cloud": { "baseUrl": "https://api.example.com/v1", "models": [{ "id": "test-model-5", "name": "Test Model 5" }] },
    "test-strata": { "baseUrl": "http://127.0.0.1:39321/v1", "models": [{ "id": "qwen3.8-flash-next-iq3_s", "name": "Qwen 3.8 Flash Next" }] }
  }
}
JSON

cat >"$CONFIG" <<'JSON'
{
  "operator": "Operator Person <operator@example.com>",
  "providers": { "test-strata": { "engine": "Strata" } }
}
JSON

printf '{"schema":1,"tool":"pi","toolVersion":"1.4.0-test","sessionId":"proof","updatedAt":"now"}\n' >"$HOME_DIR/state.json"

node "$HERE/farm-cli.ts" "$FARM" "$HERE/apply.mjs" "$HOME_DIR" "$CONFIG" "$MODELS" >/dev/null || {
	echo "farm-cli failed" >&2
	exit 1
}

CLOUD_LINE="Assisted-by: pi 1.4.0-test / Test Model 5 (cloud, Test Cloud)"
STRATA_LINE="Assisted-by: pi 1.4.0-test / Qwen 3.8 Flash Next (local, self-hosted, Strata)"
OPERATED="Operated-by: Operator Person <operator@example.com>"

# The environment a Pi session puts around every command it runs.
session_env() {
	PI_MODEL="$1"
	PI_PROVIDER="$2"
	PI_ATTR=1
	PI_ATTRIBUTION_HOME="$HOME_DIR"
	GIT_CONFIG_COUNT=1
	GIT_CONFIG_KEY_0=core.hooksPath
	GIT_CONFIG_VALUE_0="$FARM"
	export PI_MODEL PI_PROVIDER PI_ATTR PI_ATTRIBUTION_HOME GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
}
session_env test-model-5 test-cloud

new_repo() { # new_repo <dir> [author-email]
	rm -rf "$1"
	mkdir -p "$1"
	(
		cd "$1"
		git init -q -b main .
		git config user.name "Author Person"
		git config user.email "${2:-author@example.com}"
		git config commit.gpgsign false
	)
}

msg_of() { (cd "$1" && git log -1 --format=%B 2>/dev/null); }
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
count_of() { printf '%s\n' "$1" | grep -c -- "$2" || true; }

# ---------------------------------------------------------------- the table

echo "commit paths"

new_repo "$WORK/plain"
(
	cd "$WORK/plain"
	echo a >f.txt
	git add f.txt
	git commit -q -m "feat: plain message

Body line explaining it."
)
m=$(msg_of "$WORK/plain")
has "$m" "$CLOUD_LINE" && ok "-m gains the trailer" || no "-m gains the trailer" "$m"
has "$m" "$OPERATED" && ok "Operated-by appears for a different author" || no "Operated-by appears for a different author" "$m"
printf '%s\n' "$m" | grep -q "^Body line explaining it.\$" && ok "the body is untouched" || no "the body is untouched" "$m"

new_repo "$WORK/heredoc"
(
	cd "$WORK/heredoc"
	echo a >f.txt
	git add f.txt
	git commit -q -F - <<'MSG'
feat: message from stdin

Written through a heredoc, the shape a command rewriter would miss.
MSG
)
m=$(msg_of "$WORK/heredoc")
has "$m" "$CLOUD_LINE" && ok "git commit -F - gains the trailer" || no "git commit -F - gains the trailer" "$m"

new_repo "$WORK/verifyoff"
(
	cd "$WORK/verifyoff"
	echo a >f.txt
	git add f.txt
	git commit -q --no-verify -m "feat: no-verify path"
)
m=$(msg_of "$WORK/verifyoff")
has "$m" "$CLOUD_LINE" && ok "--no-verify still gains it (commit-msg is skipped, prepare-commit-msg is not)" || no "--no-verify still gains it" "$m"

new_repo "$WORK/editor"
printf '#!/bin/sh\nprintf "feat: composed in the editor\\n\\nBody.\\n" > "$1"\n' >"$WORK/fake-editor.sh"
chmod +x "$WORK/fake-editor.sh"
(
	cd "$WORK/editor"
	echo a >f.txt
	git add f.txt
	GIT_EDITOR="$WORK/fake-editor.sh" git commit -q
)
m=$(msg_of "$WORK/editor")
has "$m" "$CLOUD_LINE" && ok "an editor-composed message gains it through commit-msg" || no "an editor-composed message gains it" "$m"

new_repo "$WORK/worktree"
(
	cd "$WORK/worktree"
	echo a >f.txt
	git add f.txt
	git commit -q -m "chore: seed"
	git worktree add -q -b wt "$WORK/worktree-wt"
	cd "$WORK/worktree-wt"
	echo w >w.txt
	git add w.txt
	git commit -q -m "feat: from a linked worktree"
)
m=$(msg_of "$WORK/worktree-wt")
has "$m" "$CLOUD_LINE" && ok "a linked worktree gains it" || no "a linked worktree gains it" "$m"

new_repo "$WORK/dashC"
(
	echo a >"$WORK/dashC/f.txt"
	git -C "$WORK/dashC" add f.txt
	git -C "$WORK/dashC" commit -q -m "feat: committed with -C"
)
m=$(msg_of "$WORK/dashC")
has "$m" "$CLOUD_LINE" && ok "git -C <dir> gains it" || no "git -C <dir> gains it" "$m"

# A human at a terminal: Pi's marker and model are absent.
new_repo "$WORK/human"
(
	cd "$WORK/human"
	echo a >f.txt
	git add f.txt
	env -u PI_MODEL -u PI_PROVIDER -u PI_ATTR -u PI_CODING_AGENT git commit -q -m "docs: written by a person"
)
m=$(msg_of "$WORK/human")
[ "$m" = "docs: written by a person" ] && ok "a human commit is left exactly as written" || no "a human commit is left exactly as written" "$m"

new_repo "$WORK/byhand"
(
	cd "$WORK/byhand"
	echo a >f.txt
	git add f.txt
	git commit -q -m "feat: the model wrote the trailer itself

Assisted-by: pi 1.4.0 / Hand Written Model (cloud, Some Provider)"
)
m=$(msg_of "$WORK/byhand")
has "$m" "Hand Written Model" && ok "the hand-written line stays" || no "the hand-written line stays" "$m"
has "$m" "$CLOUD_LINE" && ok "the session's own line is added beside it" || no "the session's own line is added beside it" "$m"
[ "$(count_of "$m" "Assisted-by:")" = "2" ] && ok "two different models, two lines" || no "two different models, two lines" "$m"

# The same text twice is never written.
new_repo "$WORK/duplicate"
(
	cd "$WORK/duplicate"
	echo a >f.txt
	git add f.txt
	git commit -q -m "feat: the model wrote exactly our line

$CLOUD_LINE"
)
m=$(msg_of "$WORK/duplicate")
[ "$(count_of "$m" "Assisted-by:")" = "1" ] && ok "an identical line is not written twice" || no "an identical line is not written twice" "$m"

new_repo "$WORK/amend"
(
	cd "$WORK/amend"
	echo a >f.txt
	git add f.txt
	env -u PI_MODEL -u PI_PROVIDER -u PI_ATTR git commit -q -m "docs: human commit"
	echo b >>f.txt
	git add f.txt
	git commit -q --amend --no-edit
)
m=$(msg_of "$WORK/amend")
[ "$m" = "docs: human commit" ] && ok "--amend --no-edit on a human commit adds nothing" || no "--amend --no-edit on a human commit adds nothing" "$m"

(
	cd "$WORK/amend"
	echo c >>f.txt
	git add f.txt
	git commit -q --amend -m "docs: human commit, reworded by the session"
)
m=$(msg_of "$WORK/amend")
has "$m" "$CLOUD_LINE" && ok "--amend -m is authoring a message, so it is credited" || no "--amend -m is credited" "$m"

new_repo "$WORK/empty"
(
	cd "$WORK/empty"
	echo a >f.txt
	git add f.txt
	git commit -q --allow-empty-message --allow-empty -m ""
)
m=$(msg_of "$WORK/empty")
! has "$m" "Assisted-by:" && ok "an empty message does not get a trailer block" || no "an empty message does not get a trailer block" "$m"

# ---------------------------------------------------------------- the repository keeps its own hooks

echo
echo "the repository's own hooks"

new_repo "$WORK/hooks"
mkdir -p "$WORK/hooks/.myhooks"
printf '#!/bin/sh\nprintf "\\nChange-Id: Iabc123\\n" >> "$1"\n' >"$WORK/hooks/.myhooks/prepare-commit-msg"
printf '#!/bin/sh\necho "commit-msg ran" >>"%s/repohooks.log"\n' "$WORK" >"$WORK/hooks/.myhooks/commit-msg"
printf '#!/bin/sh\necho "post-commit ran" >>"%s/repohooks.log"\n' "$WORK" >"$WORK/hooks/.myhooks/post-commit"
printf '#!/bin/sh\necho "pre-commit ran" >>"%s/repohooks.log"\n' "$WORK" >"$WORK/hooks/.myhooks/pre-commit"
printf '#!/bin/sh\necho "pre-push ran" >>"%s/repohooks.log"\n' "$WORK" >"$WORK/hooks/.myhooks/pre-push"
chmod +x "$WORK/hooks/.myhooks"/*
(
	cd "$WORK/hooks"
	git config core.hooksPath .myhooks
	echo a >f.txt
	git add f.txt
	rm -f "$WORK/repohooks.log"
	git commit -q -m "feat: repository declares core.hooksPath"
)
m=$(msg_of "$WORK/hooks")
has "$m" "Change-Id: Iabc123" && ok "the repository's prepare-commit-msg still runs" || no "the repository's prepare-commit-msg still runs" "$m"
has "$m" "$CLOUD_LINE" && ok "and the trailer joins the same commit" || no "and the trailer joins the same commit" "$m"
[ "$(count_of "$m" "Change-Id")" = "1" ] && ok "the repository hook ran exactly once" || no "the repository hook ran exactly once" "$m"
for name in pre-commit commit-msg post-commit; do
	grep -q "$name ran" "$WORK/repohooks.log" 2>/dev/null && ok "$name still runs" || no "$name still runs" "log: $(tr '\n' ';' <"$WORK/repohooks.log" 2>/dev/null)"
done

printf '#!/bin/sh\necho refused >&2\nexit 1\n' >"$WORK/hooks/.myhooks/pre-commit"
before=$(git -C "$WORK/hooks" rev-list --count HEAD)
(
	cd "$WORK/hooks"
	echo b >>f.txt
	git add f.txt
	git commit -q -m "feat: must be blocked" >/dev/null 2>&1
	echo "exit=$?" >"$WORK/block.log"
)
after=$(git -C "$WORK/hooks" rev-list --count HEAD)
case "$(cat "$WORK/block.log")" in *"exit=1"*) ok "a failing pre-commit still blocks the commit" ;; *) no "a failing pre-commit still blocks the commit" "$(cat "$WORK/block.log")" ;; esac
[ "$before" = "$after" ] && ok "and the blocked commit is not in history ($before commits)" || no "and the blocked commit is not in history" "$before -> $after"

printf '#!/bin/sh\nexit 0\n' >"$WORK/hooks/.myhooks/pre-commit"
(
	cd "$WORK/hooks"
	git init -q --bare "$WORK/hooks-remote"
	git remote add origin "$WORK/hooks-remote"
	rm -f "$WORK/repohooks.log"
	git push -q -u origin main >/dev/null 2>&1
)
grep -q "pre-push ran" "$WORK/repohooks.log" 2>/dev/null && ok "pre-push still runs on a push" || no "pre-push still runs on a push" "$(tr '\n' ';' <"$WORK/repohooks.log" 2>/dev/null)"

# ---------------------------------------------------------------- which models a commit credits

echo
echo "which models a commit credits"

new_repo "$WORK/ledger"
(
	cd "$WORK/ledger"
	echo seed >seed.txt
	git add seed.txt
	git commit -q -m "chore: seed"
)
mkdir -p "$WORK/ledger/.git/pi-attribution"
now_ms=$(node -e 'console.log(Date.now())')
cat >"$WORK/ledger/.git/pi-attribution/ledger.jsonl" <<JSON
{"t":$now_ms,"session":"child-1","trailer":"$STRATA_LINE","files":["src/svc.go"]}
{"t":1,"session":"ancient","trailer":"Assisted-by: pi 0.0.1 / Ancient Model (cloud, Old)","files":["f.txt"]}
JSON
(
	cd "$WORK/ledger"
	mkdir -p src
	echo package >src/svc.go
	echo unrelated >f.txt
	git add src/svc.go f.txt
	git commit -q -m "feat: work a subagent wrote"
)
m=$(msg_of "$WORK/ledger")
has "$m" "$STRATA_LINE" && ok "a model recorded as having changed a committed file is credited" || no "a model recorded as having changed a committed file is credited" "$m"
has "$m" "$CLOUD_LINE" && ok "the model that ran the commit is credited too" || no "the model that ran the commit is credited too" "$m"
! has "$m" "Ancient Model" && ok "an entry older than the commit being replaced is ignored" || no "an entry older than the parent is ignored" "$m"
[ "$(count_of "$m" "Assisted-by:")" = "2" ] && ok "one line per model, no duplicates" || no "one line per model" "$m"

# The same model in the ledger as in the environment yields one line.
cat >"$WORK/ledger/.git/pi-attribution/ledger.jsonl" <<JSON
{"t":$now_ms,"session":"self","trailer":"$CLOUD_LINE","files":["src/svc.go"]}
JSON
(
	cd "$WORK/ledger"
	echo more >>src/svc.go
	git add src/svc.go
	git commit -q -m "feat: same model again"
)
m=$(msg_of "$WORK/ledger")
[ "$(count_of "$m" "Assisted-by:")" = "1" ] && ok "a model listed twice still writes one line" || no "a model listed twice still writes one line" "$m"

printf '{\n  "operator": "Operator Person <operator@example.com>",\n  "maxModels": 1,\n  "providers": { "test-strata": { "engine": "Strata" } }\n}\n' >"$CONFIG"
(
	cd "$WORK/ledger"
	echo more2 >>src/svc.go
	git add src/svc.go
	git commit -q -m "feat: capped"
)
m=$(msg_of "$WORK/ledger")
[ "$(count_of "$m" "Assisted-by:")" = "1" ] && ok "maxModels caps the block" || no "maxModels caps the block" "$m"
printf '{\n  "operator": "Author Person <author@example.com>"\n}\n' >"$CONFIG"
(
	cd "$WORK/ledger"
	echo more3 >>src/svc.go
	git add src/svc.go
	git commit -q -m "feat: operator is the author"
)
m=$(msg_of "$WORK/ledger")
! has "$m" "Operated-by:" && ok "no Operated-by when the operator is the commit author" || no "no Operated-by when the operator is the author" "$m"

# ---------------------------------------------------------------- who operated the commit

# With no `operator` in config the operator is the identity the repository authors with, so the line only
# appears when the commit was deliberately credited to someone else. Two machines or two addresses for the
# same person therefore write nothing.
printf '{}\n' >"$WORK/plain-config.json"
PLAIN_FARM="$WORK/plain-hooks"
node "$HERE/farm-cli.ts" "$PLAIN_FARM" "$HERE/apply.mjs" "$HOME_DIR" "$WORK/plain-config.json" "$MODELS" >/dev/null

new_repo "$WORK/operator-normal"
(
	cd "$WORK/operator-normal"
	echo a >f.txt
	git add f.txt
	GIT_CONFIG_VALUE_0="$PLAIN_FARM" git commit -q -m "feat: author and operator agree"
)
m=$(msg_of "$WORK/operator-normal")
! has "$m" "Operated-by:" && ok "the repository's own identity writes no Operated-by" || no "the repository's own identity writes no Operated-by" "$m"
has "$m" "$CLOUD_LINE" && ok "and the model line is still written" || no "and the model line is still written" "$m"

new_repo "$WORK/operator-author"
(
	cd "$WORK/operator-author"
	echo a >f.txt
	git add f.txt
	git commit -q --author="Someone Else <else@example.com>" -m "feat: credited to someone else"
)
m=$(msg_of "$WORK/operator-author")
has "$m" "Operated-by: Author Person <author@example.com>" && ok "an --author override writes the driving identity" || no "an --author override writes the driving identity" "$m"
[ "$(git -C "$WORK/operator-author" log -1 --format=%ae)" = "else@example.com" ] && ok "and the author stays the one that was asked for" || no "and the author stays the one that was asked for" "$(git -C "$WORK/operator-author" log -1 --format=%ae)"
(
	cd "$WORK/operator-author"
	echo b >>f.txt
	git add f.txt
	GIT_AUTHOR_EMAIL=env@example.com GIT_AUTHOR_NAME="Env Person" git commit -q -m "feat: author from the environment"
)
m=$(msg_of "$WORK/operator-author")
has "$m" "Operated-by: Author Person <author@example.com>" && ok "a GIT_AUTHOR_EMAIL override writes it as well" || no "a GIT_AUTHOR_EMAIL override writes it as well" "$m"

# ---------------------------------------------------------------- signing

# A replayed commit is not a written one: cherry-pick does not run the message hooks at all.
new_repo "$WORK/replay"
(
	cd "$WORK/replay"
	echo a >a.txt
	git add a.txt
	env -u PI_MODEL -u PI_PROVIDER -u PI_ATTR git commit -q -m "feat: human work"
	git checkout -q -b side HEAD~0 2>/dev/null || true
)
(
	cd "$WORK/replay"
	echo b >b.txt
	git add b.txt
	env -u PI_MODEL -u PI_PROVIDER -u PI_ATTR git commit -q -m "feat: second human commit"
	git checkout -q main 2>/dev/null
	git cherry-pick -q HEAD~1 >/dev/null 2>&1 || true
)
m=$(msg_of "$WORK/replay")
! has "$m" "Assisted-by:" && ok "a cherry-picked human commit is not claimed" || no "a cherry-picked human commit is not claimed" "$m"

# A repository using the default hooks directory, not a declared one.
new_repo "$WORK/defaulthooks"
printf '#!/bin/sh\necho "default pre-commit ran" >>"%s/defaulthooks.log"\n' "$WORK" >"$WORK/defaulthooks/.git/hooks/pre-commit"
chmod +x "$WORK/defaulthooks/.git/hooks/pre-commit"
(
	cd "$WORK/defaulthooks"
	echo a >f.txt
	git add f.txt
	rm -f "$WORK/defaulthooks.log"
	git commit -q -m "feat: default hooks dir"
)
m=$(msg_of "$WORK/defaulthooks")
has "$m" "$CLOUD_LINE" && ok "a default .git/hooks repository still gains the trailer" || no "a default .git/hooks repository still gains the trailer" "$m"
grep -q "default pre-commit ran" "$WORK/defaulthooks.log" 2>/dev/null && ok "and its own pre-commit still runs" || no "and its own pre-commit still runs"

echo
echo "signing"
# The key is generated for the fixture rather than looked for in a keyring: ssh-keygen is present
# wherever git is, so this runs on a CI machine with no gpg agent and no passphrase.
SIGNKEY="$WORK/signing"
if ssh-keygen -q -t ed25519 -N "" -C author@example.com -f "$SIGNKEY" 2>/dev/null; then
	printf 'author@example.com namespaces="git" %s\n' "$(cut -d' ' -f1,2 "$SIGNKEY.pub")" > "$WORK/signers"
	new_repo "$WORK/signed"
	(
		cd "$WORK/signed"
		git config gpg.format ssh
		git config user.signingkey "$SIGNKEY"
		git config gpg.ssh.allowedSignersFile "$WORK/signers"
		git config commit.gpgsign true
		echo a >f.txt
		git add f.txt
		git commit -q -m "feat: signed commit"
	)
	if [ -n "$(msg_of "$WORK/signed")" ]; then
		has "$(msg_of "$WORK/signed")" "$CLOUD_LINE" && ok "a signed commit carries the trailer" || no "a signed commit carries the trailer" "$(msg_of "$WORK/signed")"
		git -C "$WORK/signed" verify-commit HEAD >/dev/null 2>&1 && ok "and the signature still verifies" || no "and the signature still verifies" "$(git -C "$WORK/signed" verify-commit HEAD 2>&1)"
	else
		NOTE="signing skipped: the signed commit did not happen"
		printf '  --   signing skipped (the signed commit failed)\n'
	fi
else
	NOTE="signing not exercised: no ssh-keygen"
	printf '  --   no ssh-keygen available, signing not exercised\n'
fi

# ---------------------------------------------------------------- cost

echo
echo "cost"
new_repo "$WORK/cost"
(
	cd "$WORK/cost"
	timeit() {
		start=$(node -e 'console.log(Date.now())')
		git commit -q -m "chore: timed" >/dev/null 2>&1
		end=$(node -e 'console.log(Date.now())')
		printf '%s %s\n' "$1" "$((end - start))"
	}
	for i in 1 2 3; do
		echo "$i" >f.txt
		git add f.txt
		timeit with-farm
	done
	unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 PI_ATTR
	for i in 4 5 6; do
		echo "$i" >f.txt
		git add f.txt
		timeit no-hook
	done
) | awk '
	{ sum[$1] += $2; n[$1]++ ; if ($2 > max[$1]) max[$1] = $2 }
	END { for (k in sum) printf "  %-9s mean %.0f ms, worst %d ms over %d commits\n", k, sum[k] / n[k], max[k], n[k] }'

echo
echo "$PASS passed, $FAIL failed${NOTE:+ ($NOTE)}"
[ "$FAIL" -eq 0 ] || exit 1
