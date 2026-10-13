set -euo pipefail

# Runs as `prebuild` on every Vercel build. Only applies migrations on an
# actual production build with credentials configured — preview/dev builds
# no-op here so they never touch (or need access to) the prod database.
# This makes schema application atomic with the deploy that needs it: a
# failed migration fails the build, so app code can no longer ship ahead of
# its schema (the failure mode behind the #25 incident).
if [ "${VERCEL_ENV:-}" != "production" ] || [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
	echo "db-push: skipping (not a production build, or SUPABASE_DB_PASSWORD unset)"
	exit 0
fi

echo "db-push: applying pending Supabase migrations to production..."
# Pinned, not @latest: this runs against the production database on every
# build, and a CLI release that changes push behaviour must arrive by a PR.
npx --yes supabase@2.120.0 link --project-ref "$SUPABASE_PROJECT_ID"
npx --yes supabase@2.120.0 db push
echo "db-push: done."
