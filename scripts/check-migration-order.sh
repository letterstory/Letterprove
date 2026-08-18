set -euo pipefail
# Runs as part of `prebuild` on EVERY Vercel build (preview and production) --
# unlike db-push.sh's apply step, which only runs on production. Ordering
# errors were previously invisible until the post-merge production build,
# where they hard-fail the deploy (Letterprove #40/#41: a migration
# timestamped before one merged from a sibling PR broke prod because no
# preview build ever ran db-push to catch it first). This gives PR authors
# and reviewers the same signal before merge instead of after.
MIGRATIONS_DIR="supabase/migrations"
[ -d "$MIGRATIONS_DIR" ] || exit 0

echo "check-migration-order: DEBUG remotes: $(git remote -v 2>&1 | tr '\n' ';')"
echo "check-migration-order: DEBUG shallow: $(git rev-parse --is-shallow-repository 2>&1)"
echo "check-migration-order: DEBUG VERCEL_GIT_*: $(env | grep -c '^VERCEL_GIT_')"

fetch_err=$(git fetch --depth=1 origin main -q 2>&1) || {
	echo "check-migration-order: couldn't fetch origin/main, skipping ($fetch_err)"
	exit 0
}

main_files=$(git ls-tree -r --name-only origin/main -- "$MIGRATIONS_DIR" 2>/dev/null | xargs -n1 basename 2>/dev/null || true)
local_files=$(ls "$MIGRATIONS_DIR" 2>/dev/null || true)

main_max=$(printf '%s\n' "$main_files" | grep -oE '^[0-9]{14}' | sort | tail -1 || true)
if [ -z "$main_max" ]; then
	echo "check-migration-order: no migrations on origin/main yet, skipping"
	exit 0
fi

new_files=$(comm -13 <(printf '%s\n' "$main_files" | sort) <(printf '%s\n' "$local_files" | sort))
if [ -z "$new_files" ]; then
	echo "check-migration-order: ok (no new migrations vs origin/main)"
	exit 0
fi

fail=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	ts=$(printf '%s' "$f" | grep -oE '^[0-9]{14}' || true)
	[ -n "$ts" ] || continue
	if [[ "$ts" < "$main_max" || "$ts" == "$main_max" ]]; then
		echo "check-migration-order: $f ($ts) does not sort after origin/main's latest migration ($main_max)"
		echo "  supabase db push refuses to apply a migration out of order -- rename this"
		echo "  file to a timestamp later than $main_max before merging."
		fail=1
	fi
done <<<"$new_files"

if [ "$fail" -ne 0 ]; then
	exit 1
fi
echo "check-migration-order: ok (new migration(s) sort after origin/main's latest: $main_max)"
