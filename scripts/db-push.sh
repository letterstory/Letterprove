set -euo pipefail

# Runs as `prebuild` on every Vercel build. Ordering is linted on every
# build (see check-migration-order.sh); the migration is only actually
# applied on a production build with credentials configured — preview/dev
# builds no-op past the lint so they never touch (or need access to) the
# prod database. This makes schema application atomic with the deploy that
# needs it: a failed migration fails the build, so app code can no longer
# ship ahead of its schema (the failure mode behind the #25 incident).
bash "$(dirname "$0")/check-migration-order.sh"

if [ "${VERCEL_ENV:-}" != "production" ] || [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
	echo "db-push: skipping (not a production build, or SUPABASE_DB_PASSWORD unset)"
	exit 0
fi

echo "db-push: applying pending Supabase migrations to production..."
npx --yes supabase@latest link --project-ref "$SUPABASE_PROJECT_ID"
npx --yes supabase@latest db push
echo "db-push: done."
