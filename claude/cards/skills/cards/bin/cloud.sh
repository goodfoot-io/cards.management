#!/usr/bin/env bash
# Package task documents and launch once through the supported cloud CLI.
set -euo pipefail

fail() { printf 'cards cloud: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: bash cloud.sh [--dry-run] [--cards-repos DIR] CARD_ID' \
    'Run from the target code checkout. --dry-run prints the complete prompt without launching.' \
    'Defaults to ~/.cards/cards-repos; excludes .git, binary files, and symlinks.'
}

task_id=''
task_repos="${HOME:?HOME must identify the real user}/.cards/cards-repos"
task_preview=false
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) task_preview=true; shift ;;
    --cards-repos)
      (($# >= 2)) && [[ -n "$2" ]] || fail '--cards-repos requires a directory'
      task_repos=$2; shift 2 ;;
    -*) fail "unknown option: $1" ;;
    *) [[ -z "$task_id" ]] || fail 'supply exactly one card ID'; task_id=$1; shift ;;
  esac
done
[[ "$task_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'supply a card ID without path separators'
for task_tool in file iconv find sort wc; do
  command -v "$task_tool" >/dev/null || fail "required command is unavailable: $task_tool"
done

task_dir="$task_repos/$task_id"
[[ -d "$task_dir" && ! -L "$task_dir" ]] || fail "not a regular card directory: $task_dir"
task_dir=$(cd -- "$task_dir" && pwd -P) || fail 'cannot resolve the card directory'
[[ -f "$task_dir/CARD.md" && ! -L "$task_dir/CARD.md" && -r "$task_dir/CARD.md" && -s "$task_dir/CARD.md" ]] || fail 'CARD.md must be a readable, nonempty regular file'

bundle_documents() (
  cd -- "$task_dir" || exit 1
  find . -name .git -prune -o -type f -print0 | sort -z | while IFS= read -r -d '' task_file; do
    [[ ! -L "$task_file" && -f "$task_file" && -r "$task_file" ]] || fail "cannot safely read: $task_file"
    task_encoding=$(file -b --mime-encoding -- "$task_file") || fail "cannot classify: $task_file"
    [[ "$task_encoding" =~ ^[A-Za-z0-9._-]+$ ]] || fail "unknown text encoding for: $task_file"
    if [[ "$task_encoding" == binary && -s "$task_file" ]]; then
      [[ "$task_file" != ./CARD.md ]] || fail 'CARD.md was classified as binary'
      continue
    fi
    printf '\n\n--- FILE: %s ---\n' "$task_file"
    if [[ -s "$task_file" ]]; then
      iconv -f "$task_encoding" -t UTF-8 "$task_file" || fail "cannot convert text to UTF-8: $task_file"
    fi
  done
)

task_bundle=$(bundle_documents) || fail 'document bundling failed; nothing was dispatched'
task_prompt='Load cardless:captain and follow its full development workflow. Treat CARD.md as the task and the other bundled files as supporting context; labeled paths are not files in your checkout. Plan, coordinate persistent developers, implement, validate, review, commit, push only the host-assigned task branch, and create or update its PR. Honor approval gates in the task and context: stop for any required missing approval; launching does not grant it. Do not merge. Follow repository and host instructions, including attribution. The worker has no local task-management service; metadata is context, not a request to call one.'
task_prompt+=$'\n\n'
task_prompt+="$task_bundle"
task_bytes=$(printf '%s' "$task_prompt" | wc -c) || fail 'cannot measure the prompt'
# Stay below Linux's per-argument ceiling, leaving room for CLI/environment overhead.
((task_bytes <= 98304)) || fail "prompt is $task_bytes bytes; maximum is 98304. Use a larger-content transport; no files were truncated and nothing was dispatched."

if [[ "$task_preview" == true ]]; then
  printf '%s\n' "$task_prompt"
  exit 0
fi

command -v git >/dev/null || fail 'git is unavailable'
command -v claude >/dev/null || fail 'claude is unavailable'
task_checkout=$(git rev-parse --show-toplevel) || fail 'run from the target code checkout, not the card directory'
[[ "$task_checkout" != "$task_dir" && "$task_checkout" != "$task_dir/"* ]] || fail 'the dispatch checkout must be the code repository, not the card repository'
task_branch=$(git symbolic-ref --quiet --short HEAD) || fail 'the dispatch checkout has a detached HEAD'
task_changes=$(git status --porcelain) || fail 'cannot inspect the code checkout'
[[ -z "$task_changes" ]] || fail 'the code checkout is dirty; inspect and commit required changes before launch'
task_head=$(git rev-parse HEAD) || fail 'cannot resolve the dispatch commit'
task_remote=$(git config --get "branch.$task_branch.remote") || fail 'the current branch needs a configured, pushed upstream'
[[ "$task_remote" != . ]] || fail 'the upstream must be a remote, not another local branch'
task_ref=$(git config --get "branch.$task_branch.merge") || fail 'the current branch needs an upstream branch'
[[ "$task_ref" == "refs/heads/$task_branch" ]] || fail 'the upstream branch must have the same name as the dispatch branch'
task_remote_tip=$(git ls-remote --exit-code --heads "$task_remote" "$task_ref") || fail 'cannot verify the current branch on the remote'
[[ "$task_remote_tip" == "$task_head"$'\t'"$task_ref" ]] || fail 'the remote branch does not match local HEAD; synchronize before launch'

# Keep the code checkout, inherited credentials/permissions, stdin and output intact.
# No retries: a CLI error after session creation can have an uncertain outcome.
printf 'cards cloud: dispatching %s (%s prompt bytes) from %s on %s\n' "$task_id" "$task_bytes" "$task_checkout" "$task_branch" >&2
exec claude --cloud "$task_prompt"
