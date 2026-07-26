/* MathMADics — cloud accounts and global leaderboard, on Supabase (Postgres).
 *
 * Drop-in replacement for math-sprint-cloud.js. It drives the exact same DOM
 * ids and listens to the same `mathsprint:results` event, so the game core is
 * unchanged. The backend is a real Postgres database behind Supabase, with all
 * access governed by the Row-Level Security policies in schema.sql.
 *
 * Design (unchanged from the Firebase version):
 *   - Everyone gets an anonymous account on first load. Play starts immediately;
 *     nothing is gated behind sign-in.
 *   - After a solo round the results screen offers to claim a spot on the board.
 *     Claiming upgrades the anonymous account in place (Google, or an email
 *     magic link) so the guest identity and its uid survive.
 *   - Local high scores are published on claim, so history earned as a guest is
 *     not orphaned.
 *   - Email lives in auth.users only and is never part of a leaderboard row.
 *     The public identity is a separate username.
 *
 * If supabase-config.js still holds placeholders, this module disables itself
 * and the game behaves exactly as it did before.
 */

import { supabaseConfig, SDK_URL } from "./supabase-config.js";

const EMAIL_KEY = "mathsprint_email_for_signin";
const PENDING_KEY = "mathsprint_pending_result";
const PENDING_CLAIM = "mathsprint_pending_claim"; // sessionStorage flag across a redirect
const NAME_MIN = 2;
const NAME_MAX = 16;
const BOARD_SIZE = 10;    // global leaderboard: players ranked by total score
const TOP_SIZE = 10;      // highest single-game scores across everyone
const HISTORY_SIZE = 10;  // your most recent games

const $ = s => document.querySelector(s);

// ---------- Cloud UI elements ----------
const el = {
  accountBtn: $("#btn-account"),
  card: $("#cloud-card"),
  bucketLabel: $("#cloud-bucket"),
  claim: $("#claim-banner"),
  claimTitle: $("#claim-title"),
  claimSub: $("#claim-sub"),
  claimBtn: $("#btn-claim"),
  table: $("#lb-table"),
  empty: $("#lb-empty"),
  status: $("#cloud-status"),

  topCard: $("#top-card"),
  topTable: $("#top-table"),
  topEmpty: $("#top-empty"),
  topStatus: $("#top-status"),

  historyCard: $("#history-card"),
  historyTable: $("#history-table"),
  historyEmpty: $("#history-empty"),
  historyStatus: $("#history-status"),

  authModal: $("#auth-modal"),
  authClose: $("#btn-auth-close"),
  authOut: $("#auth-signed-out"),
  authIn: $("#auth-signed-in"),
  authTitle: $("#auth-title"),
  googleBtn: $("#btn-google"),
  emailForm: $("#form-email"),
  emailInput: $("#auth-email-input"),
  authStatus: $("#auth-status"),
  whoami: $("#auth-whoami"),
  renameBtn: $("#btn-rename"),
  signOutBtn: $("#btn-signout"),

  nameModal: $("#name-modal"),
  nameForm: $("#form-name"),
  nameInput: $("#name-input"),
  nameStatus: $("#name-status"),

  confirmModal: $("#confirm-modal"),
  confirmForm: $("#form-confirm"),
  confirmInput: $("#confirm-input"),
  confirmStatus: $("#confirm-status")
};

function setStatus(node, message, tone = "info") {
  if (!node) return;
  node.textContent = message || "";
  node.dataset.tone = tone;
}

function openModal(node) {
  node.classList.add("show");
  const focusable = node.querySelector("input, button");
  if (focusable) setTimeout(() => focusable.focus(), 30);
}

function closeModal(node) {
  node.classList.remove("show");
}

// ---------- Configuration gate ----------
function isConfigured(config) {
  return Boolean(
    config &&
    config.url &&
    !config.url.includes("YOUR-PROJECT") &&
    config.anonKey &&
    !config.anonKey.startsWith("REPLACE")
  );
}

if (!isConfigured(supabaseConfig)) {
  console.info("[MathMADics] Cloud features are off: fill in supabase-config.js to enable them.");
} else {
  init().catch(err => {
    console.error("[MathMADics] Cloud init failed", err);
    setStatus(el.status, "Leaderboard is unavailable right now.", "warn");
  });
}

async function init() {
  const { createClient } = await import(SDK_URL);

  const supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey, {
    auth: {
      // Implicit flow keeps magic links working when opened in a different
      // browser than the one that requested them (no client-side PKCE verifier
      // to carry across). detectSessionInUrl consumes the token on return.
      flowType: "implicit",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true
    }
  });

  let profile = null;     // { id, username } from public.profiles
  let currentBucket = null;

  // ---------- Pending guest round (held across the email-link round trip) ----------
  function setPendingResult(value) {
    try {
      if (value) localStorage.setItem(PENDING_KEY, JSON.stringify(value));
      else localStorage.removeItem(PENDING_KEY);
    } catch (e) {}
  }
  function takePendingResult() {
    let value = null;
    try {
      value = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
      localStorage.removeItem(PENDING_KEY);
    } catch (e) {}
    return value?.result && value?.game ? value : null;
  }

  // ---------- Identity helpers ----------
  let currentUser = null;
  const isNamed = () => Boolean(currentUser && !currentUser.is_anonymous);
  const hasName = () => Boolean(profile?.username);
  const canPublish = () => isNamed() && hasName();

  async function refreshUser() {
    const { data } = await supabase.auth.getUser();
    currentUser = data?.user || null;
    return currentUser;
  }

  // Where the auth provider should send the user back to. Strips auth params and
  // the hash, but keeps a ?c= challenge link intact.
  function continueUrl() {
    const url = new URL(location.href);
    for (const key of ["error", "error_description", "error_code", "code", "token", "type"]) {
      url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  }
  function cleanUrl() {
    history.replaceState(null, "", continueUrl());
  }

  // ---------- Profile reads/writes ----------
  async function loadProfile(uid) {
    try {
      const { data, error } = await supabase
        .from("profiles").select("id, username").eq("id", uid).maybeSingle();
      if (error) throw error;
      profile = data || null;
    } catch (err) {
      console.warn("[MathMADics] Could not read profile", err);
      profile = null;
    }
    return profile;
  }

  // Returns { ok } or { taken } when the username collides with someone else.
  async function saveProfile(username) {
    const user = currentUser;
    if (!user) return { ok: false };
    const { data, error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, username, updated_at: new Date().toISOString() })
      .select("id, username")
      .single();
    if (error) {
      if (error.code === "23505") return { taken: true };   // unique_violation
      throw error;
    }
    profile = data;
    return { ok: true };
  }

  // One board per scoring version; difficulty is reconciled by the multiplier.
  function bucketId(game) {
    return Number(game?.scoring) || Number(window.__scoringVersion) || 1;
  }
  function bucketLabel() {
    return "Total score across every ranked round";
  }

  async function recordScore(result, game) {
    const user = currentUser;
    if (!user) return;
    const { error } = await supabase.from("scores").insert({
      user_id: user.id,
      score: result.score,
      accuracy: result.accuracy ?? 0,
      qpm: result.qpm ?? 0,
      correct: result.correct ?? 0,
      wrong: result.wrong ?? 0,
      passed: result.passed ?? 0,
      best_streak: result.bestStreak ?? 0,
      difficulty: ["easy", "medium", "hard"].includes(game.difficulty) ? game.difficulty : "easy",
      duration: game.duration ?? 120,
      scoring: bucketId(game)
    });
    if (error) throw error;
  }

  // Recording a round is the whole write path now: every board is derived from
  // the scores table, so a plain insert feeds the personal history, the Top-10,
  // and the total-score leaderboard at once. No separate publish step.

  // Your all-time best single score, for the home-screen stat. Own rows only,
  // allowed by the scores_read_own policy.
  async function fetchPersonalBest(scoring) {
    const user = currentUser;
    if (!user) return null;
    const { data, error } = await supabase
      .from("scores")
      .select("score")
      .eq("user_id", user.id)
      .eq("scoring", scoring)
      .order("score", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? data.score : null;
  }

  // Push the personal best onto the home screen. The game core owns updateHome()
  // on window and reads window.__cloudBest from it.
  async function refreshPersonalBest(scoring) {
    if (!canPublish()) return;
    try {
      const best = await fetchPersonalBest(scoring);
      if (typeof best === "number") {
        window.__cloudBest = best;
        window.updateHome?.();
      }
    } catch (err) {
      console.warn("[MathMADics] Personal best read failed", err);
    }
  }

  // ---------- Personal history ----------
  async function fetchHistory() {
    const user = currentUser;
    if (!user) return [];
    const { data, error } = await supabase
      .from("scores")
      .select("score, accuracy, qpm, best_streak, difficulty, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(HISTORY_SIZE);
    if (error) throw error;
    return data || [];
  }

  function formatPlayedAt(iso) {
    const date = iso ? new Date(iso) : null;
    if (!date || isNaN(date)) return "Just now";
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
      ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function renderHistory(rows) {
    el.historyTable.replaceChildren();
    if (!rows.length) {
      el.historyEmpty.hidden = false;
      return;
    }
    el.historyEmpty.hidden = true;

    const head = document.createElement("tr");
    for (const label of ["When", "Score", "Level", "Accuracy", "Answers/min", "Best streak"]) {
      const th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    }
    el.historyTable.appendChild(head);

    const best = Math.max(...rows.map(row => row.score ?? 0));
    for (const row of rows) {
      const tr = document.createElement("tr");
      if ((row.score ?? 0) === best) tr.className = "lb-me";
      const difficulty = row.difficulty || "";
      const cells = [
        formatPlayedAt(row.created_at),
        String(row.score ?? 0),
        difficulty ? difficulty.charAt(0).toUpperCase() + difficulty.slice(1) : "—",
        `${row.accuracy ?? 0}%`,
        String(row.qpm ?? 0),
        String(row.best_streak ?? 0)
      ];
      for (const value of cells) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      }
      el.historyTable.appendChild(tr);
    }
  }

  async function showHistory() {
    if (!canPublish()) {
      el.historyCard.hidden = true;
      return;
    }
    el.historyCard.hidden = false;
    setStatus(el.historyStatus, "");
    try {
      renderHistory(await fetchHistory());
    } catch (err) {
      console.warn("[MathMADics] History read failed", err);
      el.historyTable.replaceChildren();
      el.historyEmpty.hidden = true;
      setStatus(el.historyStatus, "Could not load your history. Check your connection.", "warn");
    }
  }

  // ---------- Board reads ----------
  // Both public boards are served by SECURITY DEFINER functions (see schema.sql):
  // the scores table itself is owner-only, so the client can only ever see the
  // aggregated/top rows those functions return.
  const levelLabel = d => (d ? d.charAt(0).toUpperCase() + d.slice(1) : "—");

  // Fills a table element from a header spec and row-cell builder, highlighting
  // any row belonging to the current user.
  function fillTable(table, empty, headers, rows, cellsFor, myUid) {
    table.replaceChildren();
    if (!rows.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const head = document.createElement("tr");
    for (const label of headers) {
      const th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    }
    table.appendChild(head);

    rows.forEach((row, i) => {
      const tr = document.createElement("tr");
      if (row.user_id && row.user_id === myUid) tr.className = "lb-me";
      for (const value of cellsFor(row, i)) {
        const td = document.createElement("td");
        td.textContent = value; // usernames are user-supplied: never innerHTML
        tr.appendChild(td);
      }
      table.appendChild(tr);
    });
  }

  // Global leaderboard: players ranked by total score over all time.
  async function fetchLeaderboard(scoring) {
    const { data, error } = await supabase.rpc("get_total_leaderboard", {
      p_scoring: scoring,
      p_limit: BOARD_SIZE
    });
    if (error) throw error;
    return data || [];
  }

  function renderLeaderboard(rows, myUid) {
    fillTable(
      el.table, el.empty,
      ["#", "Player", "Total score", "Games"],
      rows,
      (row, i) => [
        String(i + 1),
        row.username || "Player",
        String(row.total_score ?? 0),
        String(row.games ?? 0)
      ],
      myUid
    );
  }

  // Top single-game scores across everyone.
  async function fetchTopScores(scoring) {
    const { data, error } = await supabase.rpc("get_top_scores", {
      p_scoring: scoring,
      p_limit: TOP_SIZE
    });
    if (error) throw error;
    return data || [];
  }

  function renderTopScores(rows, myUid) {
    fillTable(
      el.topTable, el.topEmpty,
      ["#", "Player", "Score", "Level", "Accuracy", "Answers/min"],
      rows,
      (row, i) => [
        String(i + 1),
        row.username || "Player",
        String(row.score ?? 0),
        levelLabel(row.difficulty),
        `${row.accuracy ?? 0}%`,
        String(row.qpm ?? 0)
      ],
      myUid
    );
  }

  // Where a just-played round lands among all single games.
  async function fetchRank(scoring, score) {
    try {
      const { data, error } = await supabase.rpc("get_score_rank", {
        p_scoring: scoring,
        p_score: score
      });
      if (error) throw error;
      return typeof data === "number" ? data : null;
    } catch (err) {
      return null;
    }
  }

  function renderAccountChip() {
    el.accountBtn.hidden = false;
    if (canPublish()) {
      el.accountBtn.textContent = profile.username;
      el.accountBtn.setAttribute("aria-label", `Account: ${profile.username}`);
    } else {
      el.accountBtn.textContent = "Sign in";
      el.accountBtn.setAttribute("aria-label", "Sign in to save scores");
    }
  }

  function renderClaimBanner(result) {
    if (canPublish()) {
      el.claim.hidden = true;
      return;
    }
    el.claim.hidden = false;
    if (result) {
      el.claimTitle.textContent = `Put ${result.score} points on the board`;
      el.claimSub.textContent = "Pick a name to save this round and start climbing the boards.";
      el.claimBtn.textContent = "Claim my spot";
    } else {
      el.claimTitle.textContent = "Claim a spot on the leaderboard";
      el.claimSub.textContent = "No password needed — Google, or a link sent to your email.";
      el.claimBtn.textContent = "Sign in";
    }
  }

  // Refresh both public boards (Top-10 and the total-score leaderboard). They are
  // world-readable, so guests and anonymous visitors see them too. `result`, when
  // present, is the round just played — used only for the placement hint.
  async function showBoards(game, result) {
    currentBucket = bucketId(game);
    const myUid = currentUser?.id;

    el.topCard.hidden = false;
    setStatus(el.topStatus, "");
    try {
      const top = await fetchTopScores(currentBucket);
      renderTopScores(top, myUid);
      if (result) {
        const onBoard = top.some(r => r.user_id === myUid && r.score === result.score);
        if (!onBoard) {
          const rank = await fetchRank(currentBucket, result.score);
          if (rank) setStatus(el.topStatus, `That round ranks around #${rank} all-time.`, "info");
        }
      }
    } catch (err) {
      console.warn("[MathMADics] Top scores read failed", err);
      el.topTable.replaceChildren();
      el.topEmpty.hidden = true;
      setStatus(el.topStatus, "Could not load the top scores. Check your connection.", "warn");
    }

    el.card.hidden = false;
    el.bucketLabel.textContent = bucketLabel();
    renderClaimBanner(result);
    setStatus(el.status, "");
    try {
      renderLeaderboard(await fetchLeaderboard(currentBucket), myUid);
    } catch (err) {
      console.warn("[MathMADics] Leaderboard read failed", err);
      el.table.replaceChildren();
      el.empty.hidden = true;
      setStatus(el.status, "Could not load the leaderboard. Check your connection.", "warn");
    }
  }

  // ---------- Name capture ----------
  let namePromise = null;
  function askDisplayName(suggestion) {
    el.nameInput.value = (suggestion || "").slice(0, NAME_MAX);
    setStatus(el.nameStatus, "");
    openModal(el.nameModal);
    namePromise = {};
    return new Promise(resolve => { namePromise.resolve = resolve; });
  }

  el.nameForm.addEventListener("submit", async e => {
    e.preventDefault();
    const value = el.nameInput.value.trim().replace(/\s+/g, " ");
    if (value.length < NAME_MIN || value.length > NAME_MAX) {
      setStatus(el.nameStatus, `Pick ${NAME_MIN}–${NAME_MAX} characters.`, "warn");
      return;
    }
    setStatus(el.nameStatus, "Saving…");
    try {
      const res = await saveProfile(value);
      if (res.taken) {
        setStatus(el.nameStatus, "That name is taken — try another.", "warn");
        return;
      }
      closeModal(el.nameModal);
      namePromise?.resolve?.(value);
      namePromise = null;
    } catch (err) {
      console.error(err);
      setStatus(el.nameStatus, "Could not save that name. Try again.", "warn");
    }
  });

  function suggestedName(user) {
    const meta = user.user_metadata || {};
    if (meta.full_name) return meta.full_name.split(" ")[0].slice(0, NAME_MAX);
    if (meta.name) return meta.name.split(" ")[0].slice(0, NAME_MAX);
    if (user.email) return user.email.split("@")[0].slice(0, NAME_MAX);
    return "";
  }

  // Runs after any successful upgrade: make sure a public name exists, then save
  // the round the player just finished as a guest (held across the sign-in round
  // trip) so it lands on the boards.
  async function finishClaim() {
    await refreshUser();
    if (!currentUser || currentUser.is_anonymous) return;
    await loadProfile(currentUser.id);
    if (!profile?.username) {
      const chosen = await askDisplayName(suggestedName(currentUser));
      if (!chosen) return;
    }
    renderAccountChip();

    let saved = false;
    const pending = takePendingResult();
    if (pending) {
      const { result, game } = pending;
      try {
        await recordScore(result, game);
        await showBoards(game, result);
        await refreshPersonalBest(bucketId(game));
        saved = true;
      } catch (err) {
        console.warn("[MathMADics] Could not save pending score", err);
      }
    } else if (currentBucket != null) {
      renderClaimBanner(null);
    }

    await showHistory();

    setStatus(
      el.status,
      saved ? "Saved. Your round is on the boards." : "You're in.",
      "good"
    );
  }

  // ---------- Sign-in: Google ----------
  // linkIdentity upgrades the current anonymous user in place (needs "Manual
  // linking" enabled in the dashboard). Always a full redirect; finishClaim runs
  // on return, detected by the PENDING_CLAIM flag during boot.
  async function claimWithGoogle() {
    setStatus(el.authStatus, "Opening Google…");
    try { sessionStorage.setItem(PENDING_CLAIM, "1"); } catch (e) {}
    const { error } = await supabase.auth.linkIdentity({
      provider: "google",
      options: { redirectTo: continueUrl() }
    });
    if (error) {
      // linkIdentity upgrades the anonymous account in place, but it only works
      // when "Allow manual linking" is enabled in the Supabase dashboard, and it
      // also fails when the Google identity already belongs to an account. In
      // every one of these cases the safe path is an ordinary Google sign-in: it
      // signs into that Google account (the same identity across all devices, so
      // history follows the player), and finishClaim() republishes the round held
      // from this session. Anonymous accounts never write to the database, so
      // nothing is lost by not upgrading in place.
      console.warn("[MathMADics] linkIdentity failed, falling back to Google sign-in:", error.message);
      const { error: e2 } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: continueUrl() }
      });
      if (e2) { try { sessionStorage.removeItem(PENDING_CLAIM); } catch (e) {} throw e2; }
      return;
    }
    // Redirect happens; nothing after this runs.
  }

  // ---------- Sign-in: email magic link ----------
  async function sendLink(email) {
    try { localStorage.setItem(EMAIL_KEY, email); } catch (e) {}
    try { sessionStorage.setItem(PENDING_CLAIM, "1"); } catch (e) {}
    // Always a magic link (OTP). It signs into whatever account owns this email —
    // creating one only if none exists — so the SAME email on a second device
    // lands on the SAME account, and its history follows the player across
    // devices. The round just finished as a guest is held in localStorage and
    // republished by finishClaim() on return, so nothing is lost.
    //
    // The old anonymous-upgrade path (updateUser) was the cross-device bug: it
    // sends an email-*change* link bound to THIS device's throwaway anonymous
    // uid. On a second device that link can never resolve to the account already
    // created on the first device — and with Supabase's email-enumeration
    // protection updateUser usually returns success even when the email is taken,
    // so the player was silently stranded on a new, empty identity with no
    // history. Anonymous accounts never write to the database (see the results
    // handler), so upgrading in place saved no data anyway.
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: continueUrl(), shouldCreateUser: true }
    });
    if (error) throw error;
  }

  // Supabase magic links carry a self-contained token, so — unlike Firebase —
  // there is normally no need to re-enter the email in another browser. The
  // confirm modal is kept only as a manual fallback if a token fails to apply.
  let confirmPromise = null;
  el.confirmForm.addEventListener("submit", e => {
    e.preventDefault();
    const value = el.confirmInput.value.trim();
    if (!value) return;
    closeModal(el.confirmModal);
    confirmPromise?.resolve?.(value);
    confirmPromise = null;
  });

  // ---------- Wiring ----------
  el.claimBtn.addEventListener("click", () => openAuthModal());
  el.accountBtn.addEventListener("click", () => openAuthModal());
  el.authClose.addEventListener("click", () => closeModal(el.authModal));
  el.authModal.addEventListener("click", e => {
    if (e.target === el.authModal) closeModal(el.authModal);
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    for (const node of [el.authModal, el.nameModal, el.confirmModal]) closeModal(node);
  });

  function openAuthModal() {
    const signedIn = canPublish();
    el.authOut.hidden = signedIn;
    el.authIn.hidden = !signedIn;
    el.authTitle.textContent = signedIn ? "Your account" : "Claim your spot";
    setStatus(el.authStatus, "");
    if (signedIn) {
      el.whoami.textContent = currentUser.email
        ? `${profile.username} · ${currentUser.email}`
        : profile.username;
    }
    openModal(el.authModal);
  }

  el.googleBtn.addEventListener("click", async () => {
    el.googleBtn.disabled = true;
    try {
      await claimWithGoogle();
    } catch (err) {
      console.error(err);
      setStatus(el.authStatus, "Google sign-in did not complete. Try the email link instead.", "warn");
    } finally {
      el.googleBtn.disabled = false;
    }
  });

  el.emailForm.addEventListener("submit", async e => {
    e.preventDefault();
    const email = el.emailInput.value.trim();
    if (!email) return;
    const button = el.emailForm.querySelector("button");
    button.disabled = true;
    setStatus(el.authStatus, "Sending…");
    try {
      await sendLink(email);
      setStatus(el.authStatus, `Link sent to ${email}. Open it to finish signing in.`, "good");
      el.emailForm.reset();
    } catch (err) {
      console.error(err);
      const message = /invalid.*email/i.test(err.message || "")
        ? "That email does not look right."
        : /redirect|url/i.test(err.message || "")
          ? "This domain is not in the Supabase redirect list yet."
          : "Could not send the link. Try again in a moment.";
      setStatus(el.authStatus, message, "warn");
    } finally {
      button.disabled = false;
    }
  });

  el.renameBtn.addEventListener("click", async () => {
    closeModal(el.authModal);
    const chosen = await askDisplayName(profile?.username || "");
    if (!chosen) return;
    renderAccountChip();
    // The boards embed the username live, so a refresh reflects the new name.
    if (currentBucket != null) await showBoards({ scoring: currentBucket }, null);
  });

  el.signOutBtn.addEventListener("click", async () => {
    closeModal(el.authModal);
    profile = null;
    await supabase.auth.signOut();
    await supabase.auth.signInAnonymously();
    await refreshUser();
    renderAccountChip();
    if (currentBucket != null) renderClaimBanner(null);
    el.historyCard.hidden = true;   // history belongs to the signed-out account
    window.__cloudBest = undefined; // personal best is per-account
    window.updateHome?.();
  });

  // ---------- Game bridge ----------
  document.addEventListener("mathsprint:results", async event => {
    const { solo, persist, result, game } = event.detail;

    if (!solo) {              // head-to-head: no boards, no personal history
      el.topCard.hidden = true;
      el.card.hidden = true;
      el.historyCard.hidden = true;
      return;
    }

    const ranked = game?.ranked !== false;

    if (persist && result && ranked) {
      if (canPublish()) {
        try {
          // Grab the old best before inserting, so we can flag a new personal best.
          const prevBest = await fetchPersonalBest(bucketId(game));
          await recordScore(result, game);
          if (result.score > (prevBest ?? -1)) {
            const banner = document.querySelector("#newbest");
            if (banner) banner.style.display = "block";
          }
          await refreshPersonalBest(bucketId(game));
        } catch (err) {
          console.warn("[MathMADics] Could not save score", err);
          setStatus(el.status, "Could not save this round to the cloud. Check your connection.", "warn");
        }
      } else {
        // Guest round: hold it across the sign-in round trip, then save on claim.
        setPendingResult({ result, game });
      }
    }

    await showBoards(game, persist && ranked ? result : null);
    if (!ranked) setStatus(el.status, "Practice round — not ranked.", "info");
    await showHistory();
  });

  // ---------- Boot ----------
  // Let supabase-js consume any token in the URL first, then settle on a user.
  await supabase.auth.getSession();
  await refreshUser();
  if (!currentUser) {
    await supabase.auth.signInAnonymously();
    await refreshUser();
  }
  if (currentUser && !currentUser.is_anonymous) {
    await loadProfile(currentUser.id);
    await refreshPersonalBest(bucketId(null));
  }
  renderAccountChip();

  // A fresh claim just landed if either we set the flag before redirecting
  // (same browser) or a magic link signed someone in who has no username yet
  // (opened in another browser).
  let claimReturning = false;
  try {
    claimReturning = sessionStorage.getItem(PENDING_CLAIM) === "1";
    sessionStorage.removeItem(PENDING_CLAIM);
  } catch (e) {}
  cleanUrl();
  if (currentUser && !currentUser.is_anonymous && (claimReturning || !profile?.username)) {
    await finishClaim();
  }

  supabase.auth.onAuthStateChange(async (evt, session) => {
    currentUser = session?.user || null;
    if (currentUser && !currentUser.is_anonymous && !profile) {
      await loadProfile(currentUser.id);
    }
    if (!currentUser || currentUser.is_anonymous) profile = null;
    renderAccountChip();
  });
}
