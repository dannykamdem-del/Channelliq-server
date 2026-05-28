const express = require("express");
const cors = require("cors");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001;
const YT = "https://www.googleapis.com/youtube/v3";
const LIBRE_TRANSLATE = "https://libretranslate.com/translate";

// ===== Sprint 3: Google OAuth constants =====
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
// =============================================

// ===== Sprint 3.5: Cost hardening =====
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ukirtgdeekjzddvgmizs.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Sample cap: never analyse more than this many comments per run
const MAX_SAMPLE_SIZE = 500;
// Cache TTL: how long sentiment results are considered fresh
const CACHE_TTL_DAYS = 7;
// Tier limits — soft launch: everyone gets 100/month
const TIER_LIMITS = { bronze: 100, silver: 100, gold: 100 };
// ======================================

app.use(cors({ origin: "*" }));
app.use(express.json());

// =====================================================================
// SPRINT 3.5: Cost hardening helpers
// =====================================================================

// Build a stable hash for cache lookups
function buildCacheKey(opts) {
  const norm = {
    s: opts.startDate || "all",
    e: opts.endDate || "all",
    f: opts.formatFilter || "all",
    n: opts.topN || "all",
    v: Array.isArray(opts.videoIds) ? [...opts.videoIds].sort().join(",") : "",
  };
  return crypto.createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 32);
}

// Supabase REST helper (server-side, uses service role to bypass RLS)
async function supabaseRest(path, opts = {}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("SUPABASE_SERVICE_ROLE_KEY not set — caching disabled");
    return null;
  }
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: opts.prefer || "return=representation",
    ...(opts.headers || {}),
  };
  try {
    const r = await fetch(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!r.ok) {
      console.error("Supabase REST error", r.status, await r.text());
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error("supabaseRest error", e.message);
    return null;
  }
}

// Look up a cached sentiment result; returns null if not found or expired
async function getCachedSentiment(channelId, cacheKey) {
  const data = await supabaseRest(
    `sentiment_cache?channel_id=eq.${encodeURIComponent(channelId)}&cache_key=eq.${encodeURIComponent(cacheKey)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=*&limit=1`
  );
  return (data && data.length) ? data[0] : null;
}

// Write a sentiment result to the cache (upserts on conflict)
async function saveCachedSentiment(channelId, cacheKey, result, commentCount, sampleSize) {
  return await supabaseRest("sentiment_cache?on_conflict=channel_id,cache_key", {
    method: "POST",
    body: {
      channel_id: channelId,
      cache_key: cacheKey,
      result,
      comment_count: commentCount,
      sample_size: sampleSize,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    },
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
}

// Record an analysis run (cache hit = 0 credits, fresh = 1 credit)
async function recordAnalysisRun({ userId, channelId, cacheHit, commentsAnalysed, sampleSize, filters }) {
  if (!userId) return; // anonymous viewers aren't tracked
  return await supabaseRest("analysis_runs", {
    method: "POST",
    body: {
      user_id: userId,
      channel_id: channelId,
      cache_hit: !!cacheHit,
      comments_analysed: commentsAnalysed || 0,
      sample_size: sampleSize || 0,
      filters: filters || null,
      credits_used: cacheHit ? 0 : 1,
      created_at: new Date().toISOString(),
    },
    headers: { Prefer: "return=minimal" },
  });
}

// How many credits has this user spent in the current calendar month?
async function getCreditsUsedThisMonth(userId) {
  if (!userId) return 0;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const data = await supabaseRest(
    `analysis_runs?user_id=eq.${encodeURIComponent(userId)}&cache_hit=eq.false&created_at=gte.${encodeURIComponent(monthStart.toISOString())}&select=id`
  );
  return Array.isArray(data) ? data.length : 0;
}

// Stratified sampling: cap analysis at MAX_SAMPLE_SIZE comments while
// preserving representativeness across like-count percentiles.
function stratifiedSample(comments, maxSize = MAX_SAMPLE_SIZE) {
  if (!comments || comments.length <= maxSize) return comments;

  const sorted = [...comments].sort((a, b) => (b.likes || 0) - (a.likes || 0));
  const topN = Math.floor(sorted.length * 0.2);
  const midN = Math.floor(sorted.length * 0.6);
  const topBucket = sorted.slice(0, topN);
  const midBucket = sorted.slice(topN, topN + midN);
  const lowBucket = sorted.slice(topN + midN);

  const takeFrom = (bucket, n) => {
    if (bucket.length <= n) return bucket;
    const step = bucket.length / n;
    const out = [];
    for (let i = 0; i < n; i++) out.push(bucket[Math.floor(i * step)]);
    return out;
  };

  const topSample = takeFrom(topBucket, Math.floor(maxSize * 0.3));
  const midSample = takeFrom(midBucket, Math.floor(maxSize * 0.5));
  const lowSample = takeFrom(lowBucket, maxSize - topSample.length - midSample.length);

  return [...topSample, ...midSample, ...lowSample];
}

// =====================================================================
// END Sprint 3.5 helpers
// =====================================================================

app.get("/", (req, res) => res.json({ status: "ChannelIQ server running" }));

app.get("/lookup", async (req, res) => {
  const { handle } = req.query;
  if (!handle) return res.status(400).json({ error: "Missing handle" });
  try {
    const h = handle.startsWith("@") ? handle.slice(1) : handle;
    const r = await fetch(`${YT}/channels?part=snippet,statistics,contentDetails,brandingSettings&forHandle=${h}&key=${process.env.YT_API_KEY}`);
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    if (!d.items?.length) return res.status(404).json({ error: "Channel not found. Check your handle and try again." });
    res.json(d.items[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/channel", async (req, res) => {
  const { channelId } = req.query;
  if (!channelId) return res.status(400).json({ error: "Missing channelId" });
  try {
    const r = await fetch(`${YT}/channels?part=snippet,statistics,contentDetails,brandingSettings&id=${channelId}&key=${process.env.YT_API_KEY}`);
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/videos", async (req, res) => {
  const { channelId } = req.query;
  if (!channelId) return res.status(400).json({ error: "Missing channelId" });
  try {
    const cr = await fetch(`${YT}/channels?part=contentDetails&id=${channelId}&key=${process.env.YT_API_KEY}`);
    const cd = await cr.json();
    if (cd.error) return res.status(400).json({ error: cd.error.message });
    const uploadsId = cd.items[0].contentDetails.relatedPlaylists.uploads;
    const pr = await fetch(`${YT}/playlistItems?part=contentDetails&playlistId=${uploadsId}&maxResults=50&key=${process.env.YT_API_KEY}`);
    const pd = await pr.json();
    if (!pd.items?.length) return res.json({ items: [] });
    const ids = pd.items.map(i => i.contentDetails.videoId).join(",");
    const vr = await fetch(`${YT}/videos?part=snippet,statistics,contentDetails&id=${ids}&key=${process.env.YT_API_KEY}`);
    const vd = await vr.json();
    if (vd.error) return res.status(400).json({ error: vd.error.message });
    res.json(vd);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/comments", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });
  try {
    const r = await fetch(`${YT}/commentThreads?part=snippet&videoId=${videoId}&maxResults=100&order=relevance&key=${process.env.YT_API_KEY}`);
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EMOJI EXTRACTION ──────────────────────────────────────────────────────────
function extractEmojis(comments) {
  const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
  const counts = {};
  for (const c of comments) {
    const matches = c.text?.match(emojiRegex) || [];
    for (const emoji of matches) {
      counts[emoji] = (counts[emoji] || 0) + 1;
    }
  }
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5).map(([emoji, count]) => ({ emoji, count }));
  const otherCount = sorted.slice(5).reduce((s, [, c]) => s + c, 0);
  const total = sorted.reduce((s, [, c]) => s + c, 0);
  return { top, otherCount, total };
}

// ── SPAM DETECTION ────────────────────────────────────────────────────────────
// Returns reason string if spam, null if legitimate
function getSpamReason(text) {
  if (!text || typeof text !== "string") return "Empty or invalid";
  const clean = text.trim();
  // Pure URL with nothing else
  if (/^https?:\/\/\S+$/.test(clean)) return "URL only";
  // Repetitive characters e.g. "hahahahaha" or "!!!!!!"
  if (/(.)\1{7,}/.test(clean)) return "Repetitive characters";
  // Pure symbols/punctuation with no letters or numbers
  if (/^[^a-zA-Z0-9\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u.test(clean)) return "Symbols only";
  // Very short AND no sentiment value — single chars, numbers only
  if (clean.length < 3) return "Too short";
  return null; // Not spam
}

function isSpam(text) {
  return getSpamReason(text) !== null;
}

// ── LANGUAGE DETECTION ────────────────────────────────────────────────────────
function detectLanguage(text) {
  const nonLatin = /[^\u0000-\u024F\u1E00-\u1EFF]/;
  if (nonLatin.test(text)) return "non-latin";
  const likely_non_english = /\b(das|der|die|und|ich|que|est|les|une|por|para|com|uma|não|sie|auf|mit|von)\b/i;
  if (likely_non_english.test(text)) return "likely-non-english";
  return "en";
}

async function translateToEnglish(text) {
  try {
    const r = await fetch(LIBRE_TRANSLATE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, source: "auto", target: "en", format: "text" })
    });
    const d = await r.json();
    return d.translatedText || text;
  } catch(_) { return text; }
}

function likeWeight(likes, maxLikes) {
  if (!maxLikes || maxLikes === 0) return 1;
  return Math.max(1, Math.round((likes / maxLikes) * 10));
}

// ── MAIN PIPELINE ─────────────────────────────────────────────────────────────
async function processComments(rawComments) {
  const filtered = [];
  const spam = [];

  for (const c of rawComments) {
    const reason = getSpamReason(c.text);
    if (reason) {
      spam.push({ ...c, spamReason: reason });
    } else {
      filtered.push(c);
    }
  }

  // Extract emoji stats from ALL comments (including filtered) before stripping
  const emojiStats = extractEmojis(rawComments);

  const maxLikes = Math.max(...filtered.map(c => parseInt(c.likes || 0)), 1);
  const mostLiked = [...filtered].sort((a, b) => parseInt(b.likes || 0) - parseInt(a.likes || 0))[0];

  const processed = [];
  for (const c of filtered) {
    const lang = detectLanguage(c.text);
    let translatedText = c.text;
    let wasTranslated = false;
    if (lang !== "en") {
      translatedText = await translateToEnglish(c.text);
      wasTranslated = true;
    }
    const likes = parseInt(c.likes || 0);
    const weight = likeWeight(likes, maxLikes);
    processed.push({
      ...c,
      originalText: c.text,
      text: translatedText,
      wasTranslated,
      language: lang,
      likes,
      weight,
      isMostLiked: c === mostLiked
    });
  }

  processed.sort((a, b) => b.weight - a.weight);

  return {
    processed,
    spam,
    emojiStats,
    stats: {
      total: rawComments.length,
      afterSpamFilter: filtered.length,
      spamRemoved: rawComments.length - filtered.length,
      translated: processed.filter(c => c.wasTranslated).length,
      mostLiked: mostLiked ? {
        text: mostLiked.text,
        likes: parseInt(mostLiked.likes || 0),
        author: mostLiked.author,
        videoTitle: mostLiked.videoTitle
      } : null,
      maxLikes
    }
  };
}

// ── POST /sentiment ────────────────────────────────────────────────────────────
app.post("/sentiment", async (req, res) => {
  const {
    comments, goal, creatorType, referenceVideoIds,
    // Sprint 3.5 additions:
    channelId,       // for caching
    userId,          // for run tracking + credit charging
    cacheKey,        // pre-computed from /sentiment-preflight (optional)
    filters,         // { startDate, endDate, formatFilter, topN, videoIds }
    forceFresh,      // if true, skip cache lookup
  } = req.body;
  if (!comments || !comments.length) return res.status(400).json({ error: "No comments provided" });

  try {
    // === Step 1: Check cache ===
    let key = cacheKey;
    if (!key && channelId && filters) {
      key = buildCacheKey({
        channelId,
        startDate: filters.startDate,
        endDate: filters.endDate,
        formatFilter: filters.formatFilter,
        topN: filters.topN,
        videoIds: filters.videoIds,
      });
    }
    if (channelId && key && !forceFresh) {
      const cached = await getCachedSentiment(channelId, key);
      if (cached && cached.result) {
        await recordAnalysisRun({
          userId, channelId,
          cacheHit: true,
          commentsAnalysed: cached.comment_count,
          sampleSize: cached.sample_size,
          filters,
        });
        return res.json({ ...cached.result, cached: true, cachedAt: cached.created_at });
      }
    }

    // === Step 2: Process comments (existing pipeline) ===
    const { processed, spam, emojiStats, stats } = await processComments(comments);
    if (!processed.length) return res.status(400).json({ error: "No valid comments after filtering" });

    // === Step 3: Stratified sample down to MAX_SAMPLE_SIZE ===
    const sampled = stratifiedSample(processed, MAX_SAMPLE_SIZE);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing Anthropic API key" });

    const weightedSample = [];
    for (const c of sampled.slice(0, 120)) {
      const repetitions = Math.min(c.weight, 3);
      for (let i = 0; i < repetitions; i++) weightedSample.push(c.text);
    }

    let goalContext = "";
    if (goal) goalContext += `The creator's primary goal is: ${goal}. `;
    if (creatorType) goalContext += `They create ${creatorType} content. `;
    if (referenceVideoIds?.length) goalContext += `Focus especially on themes relevant to growing this type of content. `;

    const sample = weightedSample.slice(0, 150).join("\n---\n");

    const prompt = `You are an expert YouTube analytics consultant analysing comments for a content creator.
${goalContext}
Important context:
- Comments weighted by like count (more liked = appears more times)
- Translated to English where needed
- Spam removed — only genuine viewer comments included
- Short positive comments like "Amazing", "Love this", "Great video" are included and should be treated as positive sentiment
- Total analysed: ${stats.afterSpamFilter} (${stats.spamRemoved} spam removed, ${stats.translated} translated)
- Statistical sample: ${sampled.length} of ${processed.length} valid comments

Analyse these weighted comments and return ONLY valid JSON with no markdown:

${sample}

Return exactly:
{
  "positive": <integer 0-100>,
  "neutral": <integer 0-100>,
  "negative": <integer 0-100>,
  "themes": [{"theme":"<name>","sentiment":"positive|neutral|negative|mixed","count":<int>,"weight":<1-10>,"examples":["<quote>","<quote>","<quote>"]}],
  "summary": "<3-4 sentence plain English summary>",
  "quickWins": ["<action 1>","<action 2>","<action 3>"],
  "audiencePersonality": "<2-3 sentence description>",
  "contentStrengths": ["<strength 1>","<strength 2>","<strength 3>"],
  "contentWeaknesses": ["<weakness 1>","<weakness 2>"]
}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message, type: d.error.type });
    const raw = (d.content || []).map(b => b.text || "").join("");
    const result = JSON.parse(raw.replace(/```json|```/g, "").trim());

    const fullResult = {
      ...result,
      pipelineStats: { ...stats, sampleSize: sampled.length },
      mostLiked: stats.mostLiked,
      spamSample: spam.slice(0, 50),
      emojiStats,
      cached: false,
    };

    // === Step 4: Save to cache + record paid run ===
    if (channelId && key) {
      saveCachedSentiment(channelId, key, fullResult, stats.afterSpamFilter, sampled.length)
        .catch(e => console.error("cache save failed", e));
    }
    recordAnalysisRun({
      userId, channelId,
      cacheHit: false,
      commentsAnalysed: stats.afterSpamFilter,
      sampleSize: sampled.length,
      filters,
    }).catch(e => console.error("run record failed", e));

    res.json(fullResult);

  } catch(e) {
    console.error("/sentiment error", e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /sentiment-preflight — estimate cost & check cache before running
app.post("/sentiment-preflight", async (req, res) => {
  try {
    const { channelId, userId, filters, commentCount } = req.body || {};
    if (!channelId) return res.status(400).json({ error: "Missing channelId" });

    const cacheKey = buildCacheKey({
      channelId,
      startDate: filters?.startDate,
      endDate: filters?.endDate,
      formatFilter: filters?.formatFilter,
      topN: filters?.topN,
      videoIds: filters?.videoIds,
    });

    const cached = await getCachedSentiment(channelId, cacheKey);
    const used = userId ? await getCreditsUsedThisMonth(userId) : 0;

    res.json({
      cacheKey,
      cacheHit: !!cached,
      cachedAt: cached?.created_at || null,
      cachedCommentCount: cached?.comment_count || null,
      estimatedCommentCount: commentCount || null,
      estimatedSampleSize: commentCount ? Math.min(commentCount, MAX_SAMPLE_SIZE) : null,
      creditsUsedThisMonth: used,
      tierLimits: TIER_LIMITS,
      cost: cached ? 0 : 1,
    });
  } catch (e) {
    console.error("/sentiment-preflight error", e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /credits?userId=... — return user's current credit usage
app.get("/credits", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "Missing userId" });
    const used = await getCreditsUsedThisMonth(userId);
    res.json({ creditsUsedThisMonth: used, tierLimits: TIER_LIMITS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// SPRINT 3: CONNECT-CHANNEL OAUTH ENDPOINTS
// =====================================================================

// ── POST /connect/exchange — exchange OAuth code for access + refresh tokens
app.post("/connect/exchange", async (req, res) => {
  try {
    const { code, redirectUri } = req.body || {};
    if (!code || !redirectUri) {
      return res.status(400).json({ error: "Missing code or redirectUri" });
    }
    if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
      return res.status(500).json({ error: "Server is missing Google OAuth credentials" });
    }

    const params = new URLSearchParams();
    params.append("code", code);
    params.append("client_id", GOOGLE_OAUTH_CLIENT_ID);
    params.append("client_secret", GOOGLE_OAUTH_CLIENT_SECRET);
    params.append("redirect_uri", redirectUri);
    params.append("grant_type", "authorization_code");

    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("OAuth exchange failed", data);
      return res.status(400).json({ error: data.error_description || data.error || "OAuth exchange failed" });
    }
    // Returns: { access_token, refresh_token, expires_in, scope, token_type, id_token }
    res.json(data);
  } catch (e) {
    console.error("exchange error", e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /connect/my-channels — list channels the authenticated user manages
app.get("/connect/my-channels", async (req, res) => {
  try {
    const accessToken = req.query.accessToken;
    if (!accessToken) return res.status(400).json({ error: "Missing accessToken" });

    const url = "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,brandingSettings,contentDetails&mine=true&maxResults=10";
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("my-channels failed", data);
      return res.status(400).json({ error: data.error?.message || "Failed to fetch channels" });
    }
    res.json({ items: data.items || [] });
  } catch (e) {
    console.error("my-channels error", e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /connect/refresh-token — get a fresh access token when the old one expires
app.post("/connect/refresh-token", async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).json({ error: "Missing refresh_token" });
    if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
      return res.status(500).json({ error: "Server is missing Google OAuth credentials" });
    }

    const params = new URLSearchParams();
    params.append("client_id", GOOGLE_OAUTH_CLIENT_ID);
    params.append("client_secret", GOOGLE_OAUTH_CLIENT_SECRET);
    params.append("refresh_token", refresh_token);
    params.append("grant_type", "refresh_token");

    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("refresh-token failed", data);
      return res.status(400).json({ error: data.error_description || data.error || "Refresh failed" });
    }
    res.json(data);
  } catch (e) {
    console.error("refresh-token error", e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /analytics — pull private YouTube Analytics for a connected channel
// Supports multiple report types via the ?type= parameter:
//   type=summary       (default) — core metrics over the date range
//   type=traffic       — views grouped by traffic source
//   type=demographics  — viewer age and gender breakdown
//   type=geography     — top countries by views
//   type=subscribers   — subscriber gained/lost over time
app.get("/analytics", async (req, res) => {
  try {
    const { channelId, accessToken, startDate, endDate, type } = req.query;
    if (!channelId || !accessToken) {
      return res.status(400).json({ error: "Missing channelId or accessToken" });
    }
    const end = endDate || new Date().toISOString().split("T")[0];
    const start = startDate || new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const reportType = type || "summary";

    // Build the YouTube Analytics request based on report type
    let metrics, dimensions = "", filters = "", sort = "", maxResults = "";
    switch (reportType) {
      case "summary":
        metrics = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares";
        break;
      case "traffic":
        metrics = "views,estimatedMinutesWatched";
        dimensions = "insightTrafficSourceType";
        sort = "-views";
        break;
      case "demographics":
        metrics = "viewerPercentage";
        dimensions = "ageGroup,gender";
        sort = "-viewerPercentage";
        break;
      case "geography":
        metrics = "views,estimatedMinutesWatched";
        dimensions = "country";
        sort = "-views";
        maxResults = "10";
        break;
      case "subscribers":
        metrics = "subscribersGained,subscribersLost";
        dimensions = "day";
        sort = "day";
        break;
      default:
        return res.status(400).json({ error: "Invalid report type. Use summary, traffic, demographics, geography or subscribers." });
    }

    // Construct the URL
    const params = new URLSearchParams();
    params.append("ids", `channel==${channelId}`);
    params.append("startDate", start);
    params.append("endDate", end);
    params.append("metrics", metrics);
    if (dimensions) params.append("dimensions", dimensions);
    if (filters) params.append("filters", filters);
    if (sort) params.append("sort", sort);
    if (maxResults) params.append("maxResults", maxResults);

    const url = `https://youtubeanalytics.googleapis.com/v2/reports?${params.toString()}`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("analytics failed", reportType, data);
      return res.status(400).json({ error: data.error?.message || "Analytics request failed", type: reportType });
    }
    res.json({ type: reportType, startDate: start, endDate: end, ...data });
  } catch (e) {
    console.error("analytics error", e);
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// END SPRINT 3 OAUTH ENDPOINTS
// =====================================================================

app.listen(PORT, () => console.log("ChannelIQ server running on port " + PORT));
