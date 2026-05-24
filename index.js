const express = require("express");
const cors = require("cors");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

const app = express();
const PORT = process.env.PORT || 3001;
const YT = "https://www.googleapis.com/youtube/v3";
const LIBRE_TRANSLATE = "https://libretranslate.com/translate";

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "ChannelIQ server running" }));

app.get("/lookup", async (req, res) => {
  const { handle } = req.query;
  if (!handle) return res.status(400).json({ error: "Missing handle" });
  try {
    const h = handle.startsWith("@") ? handle.slice(1) : handle;
    const r = await fetch(`${YT}/channels?part=snippet,statistics,contentDetails&forHandle=${h}&key=${process.env.YT_API_KEY}`);
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
    const r = await fetch(`${YT}/channels?part=snippet,statistics,contentDetails&id=${channelId}&key=${process.env.YT_API_KEY}`);
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

// ── COMMENT PROCESSING PIPELINE ───────────────────────────────────────────────

// Step 1: Spam filter
function isSpam(text) {
  if (!text || typeof text !== "string") return true;
  const clean = text.trim();
  // Too short
  if (clean.length < 10) return true;
  // Only emoji or symbols
  if (/^[\p{Emoji}\s\W]+$/u.test(clean)) return true;
  // Word count under 3
  const words = clean.split(/\s+/).filter(w => w.length > 1);
  if (words.length < 3) return true;
  // Repetitive characters e.g. "hahahahaha" or "!!!!!!"
  if (/(.)\1{5,}/.test(clean)) return true;
  // Pure URL
  if (/^https?:\/\/\S+$/.test(clean)) return true;
  return false;
}

// Step 2: Language detection (simple heuristic — checks for non-Latin characters)
function detectLanguage(text) {
  const nonLatin = /[^\u0000-\u024F\u1E00-\u1EFF]/;
  if (nonLatin.test(text)) return "non-latin";
  // Common non-English word patterns (very basic)
  const likely_non_english = /\b(das|der|die|und|ich|que|est|les|une|por|para|com|uma|não|und|sie|auf|mit|von)\b/i;
  if (likely_non_english.test(text)) return "likely-non-english";
  return "en";
}

// Step 3: Translate non-English comments
async function translateToEnglish(text) {
  try {
    const r = await fetch(LIBRE_TRANSLATE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: text,
        source: "auto",
        target: "en",
        format: "text"
      })
    });
    const d = await r.json();
    return d.translatedText || text;
  } catch(_) {
    return text; // Fall back to original if translation fails
  }
}

// Step 4: Calculate like weight
// Returns a normalised weight between 1 and 10
function likeWeight(likes, maxLikes) {
  if (!maxLikes || maxLikes === 0) return 1;
  const normalised = likes / maxLikes;
  return Math.max(1, Math.round(normalised * 10));
}

// Step 5: Full pipeline
async function processComments(rawComments) {
  // Filter spam first
  const filtered = rawComments.filter(c => !isSpam(c.text));

  // Find max likes for normalisation
  const maxLikes = Math.max(...filtered.map(c => parseInt(c.likes || 0)), 1);

  // Find most liked comment
  const mostLiked = [...filtered].sort((a, b) => parseInt(b.likes || 0) - parseInt(a.likes || 0))[0];

  // Process each comment
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

  // Sort by weight descending so most significant comments come first
  processed.sort((a, b) => b.weight - a.weight);

  return {
    processed,
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
  const { comments, goal, creatorType, referenceVideoIds } = req.body;
  if (!comments || !comments.length) return res.status(400).json({ error: "No comments provided" });

  try {
    // Run pipeline
    const { processed, stats } = await processComments(comments);

    if (!processed.length) return res.status(400).json({ error: "No valid comments after filtering" });

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(500).json({ error: "Missing Anthropic API key" });

    // Build weighted comment sample for Claude
    // Repeat higher-weight comments to naturally emphasise them
    const weightedSample = [];
    for (const c of processed.slice(0, 120)) {
      const repetitions = Math.min(c.weight, 3);
      for (let i = 0; i < repetitions; i++) {
        weightedSample.push(c.text);
      }
    }

    // Build goal context string
    let goalContext = "";
    if (goal) goalContext += `The creator's primary goal is: ${goal}. `;
    if (creatorType) goalContext += `They create ${creatorType} content. `;
    if (referenceVideoIds?.length) goalContext += `Focus especially on themes relevant to growing this type of content. `;

    const sample = weightedSample.slice(0, 150).join("\n---\n");

    const prompt = `You are an expert YouTube analytics consultant analysing comments for a content creator.
${goalContext}
Important context:
- Comments have been weighted by like count (more liked comments appear more times)
- Comments have been translated to English where needed
- Spam has been removed
- Total comments analysed: ${stats.afterSpamFilter} (${stats.spamRemoved} spam removed, ${stats.translated} translated)

Analyse these weighted comments and return ONLY valid JSON with no markdown:

${sample}

Return exactly this structure:
{
  "positive": <integer 0-100>,
  "neutral": <integer 0-100>,
  "negative": <integer 0-100>,
  "themes": [
    {
      "theme": "<specific theme name>",
      "sentiment": "positive|neutral|negative|mixed",
      "count": <integer>,
      "weight": <1-10 significance score>,
      "examples": ["<real quote 1>", "<real quote 2>", "<real quote 3>"]
    }
  ],
  "summary": "<3-4 sentence plain English summary tailored to the creator's goal if provided>",
  "quickWins": ["<specific actionable recommendation 1>", "<specific actionable recommendation 2>", "<specific actionable recommendation 3>"],
  "audiencePersonality": "<2-3 sentence description of who this audience is and what they care about>",
  "contentStrengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "contentWeaknesses": ["<weakness 1>", "<weakness 2>"]
}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
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

    // Attach pipeline stats and most liked comment to response
    res.json({
      ...result,
      pipelineStats: stats,
      mostLiked: stats.mostLiked
    });

  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log("ChannelIQ server running on port " + PORT));
