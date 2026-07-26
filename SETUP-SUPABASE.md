# Accounts and leaderboard setup (Supabase)

All scores live in the cloud now — there is no local high-score list. With
Supabase unconfigured the cloud UI stays hidden and no boards appear at all, so
the setup below is required for scores to be saved and shown.

The three boards, all derived from the `scores` table:

- **Your last 10 games** — your own recent rounds (private).
- **Top 10 scores** — the highest single rounds anyone has played.
- **Global leaderboard** — players ranked by their total score over all time.

## How it works

- **Nobody is asked to sign in to play.** On load every visitor gets an
  anonymous Supabase account. Play starts immediately.
- **The ask comes after a round.** The results screen shows the global board and
  a banner offering to put the score on it.
- **Claiming signs you into one durable account per person.** The round you just
  finished as a guest is held across the sign-in round trip (in `localStorage`)
  and recorded the moment you land back, signed in — nothing is saved until a
  name is claimed.
  - **Email** uses a magic link (`signInWithOtp`). It signs into whatever account
    already owns that address, and creates one only if none exists. That is what
    makes **history follow you across devices**: the same email always resolves
    to the same account, so games played on your phone show up when you sign in
    on a laptop. (An earlier version upgraded the anonymous guest in place with
    `updateUser`, which stranded second devices on a separate empty account —
    that was the "my history is missing" bug.)
  - **Google** upgrades the anonymous guest in place with `linkIdentity` when
    **manual linking** is enabled; if it is off (or the Google identity already
    belongs to an account), it falls back to a normal Google sign-in. Either way
    the same Google account resolves to the same MathMADics account on every
    device. Because anonymous guests never write to the database, upgrading in
    place saves no data over signing in fresh — the fallback loses nothing.
- **Email is private.** It lives in `auth.users` only. The public leaderboard
  entry carries a separate **username** (a nickname — real names not required).
- **Google first, magic link second.** The email link exists for people without
  a Google account. The emailed link is the proof of a legitimate person; there
  is never a password.

## 1. Create the project

1. Sign up at [supabase.com](https://supabase.com) and create a new project
   (the free tier is plenty). Pick a region close to your players.
2. **Project Settings → Data API**: copy the **Project URL**.
   **Project Settings → API Keys**: copy the **anon / public** key.
3. Paste both into [supabase-config.js](supabase-config.js), replacing the
   placeholders. (These are not secrets — access is controlled by RLS.)

## 2. Create the database

1. **SQL Editor → New query**, paste all of [schema.sql](schema.sql), and Run.
   This creates `profiles` and `scores`, the Row-Level Security policies, and the
   three `SECURITY DEFINER` read functions that serve the public boards
   (`get_top_scores`, `get_total_leaderboard`, `get_score_rank`). It is safe to
   re-run: it drops the obsolete `leaderboard` table and `publish_score()` from
   the previous version.

## 3. Enable the auth methods

1. **Authentication → Sign In / Providers**:
   - **Email** — enabled by default. Make sure "Confirm email" is on (that's the
     magic link).
   - **Anonymous sign-ins** — turn **on** (Authentication → Sign In / Providers,
     or Settings). Required, or nobody can play.
   - **Google** — enable it and paste a Google OAuth **Client ID** and
     **Secret** (from Google Cloud Console → Credentials → OAuth client, type
     "Web application"). In that Google client, add Supabase's callback URL:
     `https://YOUR-PROJECT-ref.supabase.co/auth/v1/callback`.
   - **Allow manual linking** — turn **on** (Authentication → Sign In / Providers
     → bottom, or Auth settings). This lets a signed-in anonymous guest attach a
     Google identity in place instead of creating a second account. **Recommended
     but no longer required:** if it is off, the Google button now falls back to a
     normal Google sign-in, so it still works — you will just see one failed
     `identities/authorize` request (`Manual linking is disabled`) in the console
     before the fallback runs. Turning it on removes that.
2. **Authentication → URL Configuration**:
   - **Site URL**: the address you serve from (e.g. `http://localhost:3000`).
   - **Redirect URLs**: add every URL a magic link may return to, e.g.
     `http://localhost:3000/math-sprint-v3.html` and your production URL.

## 4. Serve it locally

Auth does not work from `file://`. Serve over http:

```
npx serve .          # then open http://localhost:3000/math-sprint-v3.html
```

## 5. Deploy to production

The live site (`https://www.mathmadics.com/`) runs on Cloudflare as a **Worker
with static assets** named **`mathmadicsapp`** — *not* a Cloudflare Pages project.
The folder it serves is [dist/](dist/): `dist/index.html` is a copy of
`math-sprint-v3.html`, alongside `math-sprint-supabase.js`, `math-sprint-v3.css`,
and `supabase-config.js` at the site root.

**One command** — [deploy.sh](deploy.sh) refreshes `dist/` from the root source
files and runs `wrangler deploy`:

```
./deploy.sh
```

The deploy target is fixed in [wrangler.toml](wrangler.toml) (`name =
"mathmadicsapp"`, `[assets] directory = "./dist"`), so `wrangler deploy` updates
the existing Worker — and leaves its `www.mathmadics.com` custom domain in place —
rather than creating anything new. The first run opens a browser to log in to
Cloudflare.

**Node version note.** `wrangler@latest` requires **Node ≥22**; on Node 20 it
hard-errors. `deploy.sh` handles this by falling back to `wrangler@4.40.0` (which
supports Node 18–20) until you upgrade. To upgrade with nvm:
`nvm install --lts && nvm use --lts`.

**Doing it by hand** (what the script automates):

```
cp math-sprint-v3.html      dist/index.html
cp math-sprint-supabase.js  dist/math-sprint-supabase.js
cp math-sprint-v3.css       dist/math-sprint-v3.css
cp supabase-config.js       dist/supabase-config.js
npx wrangler@4.40.0 deploy      # or wrangler@latest on Node ≥22
```

> **Note — the Firebase files are stale.** `firebase.json`, `.firebaserc`, and
> `.firebase/` are leftovers from an earlier Firebase build and are **not** used:
> hosting is Cloudflare, and the database is Supabase. Do not run `firebase
> deploy` — it would target the abandoned Firebase project, not the live site.
> These have been moved out of the way into
> [_archived/firebase-legacy/](_archived/firebase-legacy/); nothing the live site
> loads references them, so they are safe to delete entirely whenever you like.

## Things worth knowing

**Implicit auth flow.** The client uses `flowType: "implicit"` so a magic link
works even when opened in a different browser than the one that requested it
(there is no client-side PKCE verifier to carry across). This is the single most
common "the link didn't work" complaint, avoided. The trade-off is that the
access token rides in the URL fragment on return; it is consumed and stripped
immediately on load.

**Google needs its own project — and keep it OFF Firebase.** Unlike anonymous and
email, Google sign-in requires a Google Cloud OAuth client. Create it in a
standalone Google Cloud project you control, **not** a Firebase-linked one:
Firebase auto-creates an OAuth client, and deleting the Firebase project deletes
that client. (That is exactly what happened once here — Supabase kept pointing at
client `25808057684-…apps.googleusercontent.com` from the old Firebase project
`math-sprint-b05a5`, and after Firebase teardown Google returned
`Error 401: deleted_client — The OAuth client was deleted`.)

**Fixing `deleted_client` / a broken Google client.** Create a fresh OAuth client
(APIs & Services → Credentials → Create Credentials → OAuth client ID → Web
application), add `https://YOUR-PROJECT-ref.supabase.co/auth/v1/callback` as an
Authorized redirect URI, publish the consent screen to Production (basic
email/profile scopes need no Google review), then paste the new Client ID and
Secret into Supabase → Authentication → Sign In / Providers → Google. No code or
redeploy needed — the client ID/secret live only in Supabase.

**The boards are cheatable.** Scores are computed in the browser, so anyone can
open devtools and insert any number. RLS ensures a user can only write their own
rows, and the public boards are read-only functions — but nothing can tell a real
900 from a forged one. For a friendly game this is fine; hardening it would mean
validating rounds server-side.

**Resetting the boards.** `delete from public.scores;` in the SQL editor clears
everything — all three boards are derived from that one table.

## Rolling back to Firebase

The old Firebase backend module still exists, archived under
[_archived/firebase-legacy/](_archived/firebase-legacy/) (along with
`firebase-config.js` and the old `SETUP-AUTH.md`). To roll back, move
`math-sprint-cloud.js` and `firebase-config.js` back to the repo root and change
the last script tag in [math-sprint-v3.html](math-sprint-v3.html) to:

```html
<script type="module" src="math-sprint-cloud.js"></script>
```
