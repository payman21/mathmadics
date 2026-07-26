#!/usr/bin/env bash
#
# Deploy MathMADics — one command:  ./deploy.sh
#
# WHAT THIS DEPLOYS
#   The website (static HTML/JS/CSS) to Cloudflare as the Worker "mathmadicsapp"
#   — the Worker-with-static-assets that serves https://www.mathmadics.com/.
#   It is a WORKER, not a Cloudflare Pages project. This is where the game code
#   (including the Google-auth and cross-device-history fixes) goes live.
#
#   The deploy target (Worker name + asset directory) is set in wrangler.toml,
#   so there is nothing to type — every run deploys to the same Worker.
#
#   Supabase is NOT deployed here: it is only the database/auth backend. Its
#   schema is applied once via the Supabase SQL editor (see SETUP-SUPABASE.md),
#   and does not change when you edit the game.
#
# WHAT IT DOES
#   1. Picks a wrangler version compatible with your Node.
#   2. Ensures you are logged in to Cloudflare (opens a browser the first time).
#   3. Refreshes dist/ from the source files at the repo root.
#   4. Runs `wrangler deploy` to upload dist/ to the "mathmadicsapp" Worker.
#
# Requires Node (for npx). Nothing to install globally — wrangler runs via npx.

set -euo pipefail
cd "$(dirname "$0")"

# --- 1. Pick a wrangler that matches your Node version ------------------------
# wrangler@latest requires Node >=22. On older Node (e.g. the v20 from nvm) it
# hard-errors, so fall back to wrangler@4.40.0, which supports Node 18-20 and
# still does static-assets deploys. After you upgrade Node
# (nvm install --lts && nvm use --lts), this switches to wrangler@latest itself.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -ge 22 ]; then
  WRANGLER="npx --yes wrangler@latest"
else
  echo "→ Node v$(node -v | tr -d v) detected. wrangler@latest needs Node 22+,"
  echo "  so this run uses wrangler@4.40.0 (supports Node 18-20)."
  echo "  Optional upgrade:  nvm install --lts && nvm use --lts"
  echo
  WRANGLER="npx --yes wrangler@4.40.0"
fi

# --- 2. Cloudflare login (opens a browser the first time) ---------------------
if $WRANGLER whoami 2>&1 | grep -qiE "not authenticated|not logged in"; then
  echo "→ Not logged in to Cloudflare. Opening a browser to log in…"
  $WRANGLER login
fi

# --- 3. Refresh dist/ from the source of truth (repo root) --------------------
echo "→ Syncing dist/ from root source files…"
mkdir -p dist
cp math-sprint-v3.html     dist/index.html
cp math-sprint-supabase.js dist/math-sprint-supabase.js
cp math-sprint-v3.css      dist/math-sprint-v3.css
cp supabase-config.js      dist/supabase-config.js

# --- 4. Deploy the Worker (target defined in wrangler.toml) -------------------
echo "→ Deploying dist/ to the 'mathmadicsapp' Worker…"
$WRANGLER deploy

echo
echo "✓ Deployed. Give it a few seconds, then hard-refresh https://www.mathmadics.com/"

# -----------------------------------------------------------------------------
# OPTIONAL — pushing the Supabase schema from the CLI
# -----------------------------------------------------------------------------
# You normally do NOT need this; schema.sql is a one-time setup applied in the
# Supabase dashboard's SQL editor. If you'd rather run it from the terminal
# after editing schema.sql:
#
#   psql "$SUPABASE_DB_URL" -f schema.sql
#
# where SUPABASE_DB_URL is the connection string from
# Supabase -> Project Settings -> Database -> Connection string (URI).
