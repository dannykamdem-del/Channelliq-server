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
// Sprint 3.5 fix: raise body limit so large comment payloads don't trigger 413.
// Client also samples before sending, but this is a safety net.
app.use(express.json({ limit: "25mb" }));

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
// Improved language detection (Sprint 3.5).
// English-only sentiment works fine, but Claude's sentiment is more accurate
// with translated input. Cast a wider net by checking:
//   1. Non-Latin scripts (Cyrillic, CJK, Arabic, Thai, Hindi, etc) → translate
//   2. Latin-extended accented characters that English doesn't use → translate
//   3. A much larger bag of common function words across major YouTube languages
function detectLanguage(text) {
  if (!text || typeof text !== "string") return "en";
  const t = text.trim();
  if (t.length < 3) return "en"; // too short to detect

  // 1. Non-Latin scripts — almost certainly need translation
  // Covers Cyrillic, Greek, Hebrew, Arabic, Devanagari, Thai, Hangul, Japanese, Chinese, etc.
  if (/[\u0370-\u03FF\u0400-\u04FF\u0500-\u052F\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0900-\u097F\u0E00-\u0E7F\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(t)) {
    return "non-latin";
  }

  // 2. Accented characters that English doesn't use (Spanish, Portuguese, French,
  //    German, Italian, Polish, Vietnamese, Turkish, Czech, Romanian, etc.)
  if (/[áàâãäåçéèêëíìîïñóòôõöøúùûüýÿæœßÁÀÂÃÄÅÇÉÈÊËÍÌÎÏÑÓÒÔÕÖØÚÙÛÜÝŸÆŒĄĆĘŁŃŚŹŻąćęłńśźżĞŞİığşčďěňřšťůž]/.test(t)) {
    return "likely-non-english";
  }

  // 3. Big bag of common non-English function words. Word-boundary case-insensitive match.
  //    Covers: German, Spanish, French, Italian, Portuguese, Dutch, Polish, Romanian,
  //    Indonesian/Malay, Tagalog, Vietnamese (Latin), Romanian, Turkish.
  const nonEn = /\b(das|der|die|und|ich|bin|nicht|aber|auch|sehr|ja|nein|was|ist|sind|haben|kann|wird|werden|sein|mit|von|für|über|bei|aus|nach|durch|ohne|gegen|que|qué|para|por|con|sin|pero|muy|más|mejor|también|cómo|cuándo|dónde|porqué|gracias|hola|sí|aquí|allí|cuál|une|un|une|deux|trois|c\u2019est|cest|n\u2019est|tres|très|aussi|merci|bonjour|oui|non|mais|avec|sans|pour|sur|sous|sopra|sotto|sempre|grazie|ciao|sì|però|com|uma|para|porque|obrigad|olá|sim|não|ainda|onde|quando|quem|mais|menos|met|niet|ook|hoe|wat|waar|maar|zonder|voor|naar|dziękuję|jest|być|mam|ten|dla|jak|gdzie|kiedy|mulțumesc|așa|când|unde|cum|cred|terima|kasih|tidak|saya|kamu|untuk|dengan|tetapi|salamat|po|kasi|kasi|naman|talaga|teşekkür|merhaba|evet|hayır|nasıl|nerede|neden|nasıl|cảm|ơn|không|được|và|làm|tôi|của|ở)\b/i;
  if (nonEn.test(t)) return "likely-non-english";

  return "en";
}

// Fetch with a hard timeout — returns null if the request takes longer than `ms`
async function fetchWithTimeout(url, options = {}, ms = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    fetch(url, options)
      .then(r => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
  });
}

async function translateToEnglish(text) {
  // 3 second hard timeout — LibreTranslate's free endpoint is often slow/down
  const r = await fetchWithTimeout(LIBRE_TRANSLATE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, source: "auto", target: "en", format: "text" })
  }, 3000);
  if (!r) return text; // timed out — keep original
  try {
    const d = await r.json();
    return d.translatedText || text;
  } catch (_) { return text; }
}

// Translate an array of comments in parallel with a concurrency cap
async function translateBatch(comments, concurrency = 5) {
  const results = new Array(comments.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= comments.length) return;
      const c = comments[idx];
      try {
        results[idx] = { ...c, translated: await translateToEnglish(c.text) };
      } catch (_) {
        results[idx] = { ...c, translated: c.text };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, comments.length) }, worker));
  return results;
}

function likeWeight(likes, maxLikes) {
  if (!maxLikes || maxLikes === 0) return 1;
  return Math.max(1, Math.round((likes / maxLikes) * 10));
}

// ── MAIN PIPELINE ─────────────────────────────────────────────────────────────
// IMPORTANT order of operations to keep this fast even for big channels:
//   1. Spam filter (instant, in-memory)
//   2. Weight by likes (instant)
//   3. Stratified sample to MAX_SAMPLE_SIZE (instant)
//   4. Translate only the sampled subset, in parallel with timeouts
async function processComments(rawComments) {
  const filtered = [];
  const spam = [];

  for (const c of rawComments) {
    const reason = getSpamReason(c.text);
    if (reason) spam.push({ ...c, spamReason: reason });
    else filtered.push(c);
  }

  // Emoji stats from EVERYTHING (including spam, which often has emoji)
  const emojiStats = extractEmojis(rawComments);

  const maxLikes = Math.max(...filtered.map(c => parseInt(c.likes || 0)), 1);
  const mostLiked = [...filtered].sort((a, b) =>
    parseInt(b.likes || 0) - parseInt(a.likes || 0)
  )[0];

  // Annotate each filtered comment with likes + weight + language detection
  // (NO translation yet — we only translate after sampling)
  const annotated = filtered.map(c => {
    const likes = parseInt(c.likes || 0);
    return {
      ...c,
      originalText: c.text,
      text: c.text, // placeholder, may get overwritten by translation later
      language: detectLanguage(c.text),
      likes,
      weight: likeWeight(likes, maxLikes),
      isMostLiked: c === mostLiked,
    };
  });

  // Sort by weight so the sample upstream pulls the most influential first
  annotated.sort((a, b) => b.weight - a.weight);

  // Sample BEFORE we do any expensive translation work
  const sampledForTranslation = stratifiedSample(annotated, MAX_SAMPLE_SIZE);

  // Translate only the sampled comments that need it, in parallel
  const needsTranslation = sampledForTranslation.filter(c => c.language !== "en");
  const okAsIs = sampledForTranslation.filter(c => c.language === "en");
  let translatedComments = [];
  if (needsTranslation.length) {
    const translated = await translateBatch(needsTranslation, 5);
    translatedComments = translated.map(c => ({
      ...c,
      text: c.translated,
      wasTranslated: c.translated !== c.originalText,
    }));
  }
  // Combine, re-sort by weight (translation may have shuffled order)
  const processed = [...okAsIs.map(c => ({ ...c, wasTranslated: false })), ...translatedComments]
    .sort((a, b) => b.weight - a.weight);

  return {
    processed,
    spam,
    emojiStats,
    stats: {
      total: rawComments.length,
      afterSpamFilter: filtered.length,
      spamRemoved: rawComments.length - filtered.length,
      translated: processed.filter(c => c.wasTranslated).length,
      sampledForAnalysis: processed.length,
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
    // Sprint 3.5 fix: client now computes accurate population stats and sends them.
    // The server merges these into the response so the user sees TRUE totals,
    // not the sampled subset.
    clientPipelineStats, // { total, afterSpamFilter, spamRemoved } from full raw fetch
    clientEmojiStats,    // emoji counts from the FULL raw population (not just sample)
    clientSpamSample,    // up to 50 spam comments for the drill-down view
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

    // === Step 2: Process comments (spam filter, sample, translate in parallel) ===
    const { processed, spam, emojiStats, stats } = await processComments(comments);
    if (!processed.length) return res.status(400).json({ error: "No valid comments after filtering" });

    // processComments already samples internally to MAX_SAMPLE_SIZE, so `processed`
    // is the final analysis set — no need to sample again.
    const sampled = processed;

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

    const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 6000,
        messages: [{ role: "user", content: prompt }]
      })
    }, 25000); // 25 second timeout — well within Railway's request limit

    if (!r) {
      return res.status(504).json({ error: "AI analysis timed out — try fewer videos or a narrower date range" });
    }

    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message, type: d.error.type });
    const raw = (d.content || []).map(b => b.text || "").join("");
    const cleaned = raw.replace(/```json|```/g, "").trim();
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseErr) {
      // Fallback: truncate to the last complete JSON object closure and retry
      const lastBrace = cleaned.lastIndexOf("}");
      if (lastBrace > 0) {
        try {
          result = JSON.parse(cleaned.slice(0, lastBrace + 1));
          console.warn("Sentiment JSON was repaired — original was truncated by", cleaned.length - lastBrace - 1, "chars");
        } catch (retryErr) {
          console.error("Sentiment JSON repair also failed:", retryErr.message);
          return res.status(502).json({
            error: "AI returned malformed output. This usually means the response was too long. Try selecting fewer videos and retry.",
            detail: parseErr.message,
          });
        }
      } else {
        console.error("Sentiment JSON unparseable:", parseErr.message);
        return res.status(502).json({
          error: "AI returned an unparseable response. Please retry.",
          detail: parseErr.message,
        });
      }
    }

    // Sprint 3.5 fix: prefer client-provided population stats (true totals)
    // over server stats (only the sampled subset). When client stats aren't
    // available (older client), fall back to server stats.
    //
    // Translation count is upweighted: if X% of the sample needed translating,
    // we estimate that X% of the population did too.
    const samplePostSpam = stats.afterSpamFilter; // # comments in sample after server spam filter
    const sampleTranslated = stats.translated;
    const translatedRate = samplePostSpam > 0 ? sampleTranslated / samplePostSpam : 0;
    const populationAfterSpam = clientPipelineStats?.afterSpamFilter ?? stats.afterSpamFilter;
    const estimatedPopulationTranslated = Math.round(populationAfterSpam * translatedRate);

    const fullResult = {
      ...result,
      pipelineStats: {
        // Show TRUE population totals (from client) — falls back to sample if unavailable
        total: clientPipelineStats?.total ?? stats.total,
        afterSpamFilter: populationAfterSpam,
        spamRemoved: clientPipelineStats?.spamRemoved ?? stats.spamRemoved,
        translated: estimatedPopulationTranslated,
        // Sample size is for internal use, not displayed to end users
        _sampleSize: sampled.length,
      },
      mostLiked: stats.mostLiked,
      // Prefer client's spam sample (real spam from full population), fall back to server
      spamSample: clientSpamSample && clientSpamSample.length ? clientSpamSample : spam.slice(0, 50),
      // Prefer client's emoji stats (counted from full population)
      emojiStats: clientEmojiStats || emojiStats,
      cached: false,
    };

    // === Step 4: Save to cache + record paid run ===
    if (channelId && key) {
      saveCachedSentiment(channelId, key, fullResult, populationAfterSpam, sampled.length)
        .catch(e => console.error("cache save failed", e));
    }
    recordAnalysisRun({
      userId, channelId,
      cacheHit: false,
      commentsAnalysed: populationAfterSpam,
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
