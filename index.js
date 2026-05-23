const express = require("express");
const cors    = require("cors");
const fetch   = (...a) => import("node-fetch").then(({default:f}) => f(...a));

const app  = express();
const PORT = process.env.PORT || 3001;
const YT   = "https://www.googleapis.com/youtube/v3";

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "ChannelIQ server running" }));

app.get("/channel", async (req, res) => {
  const { apiKey, channelId } = req.query;
  if (!apiKey || !channelId) return res.status(400).json({ error: "Missing apiKey or channelId" });
  try {
    const r = await fetch(`${YT}/channels?part=snippet,statistics,contentDetails&id=${channelId}&key=${apiKey}`);
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/videos", async (req, res) => {
  const { apiKey, channelId } = req.query;
  if (!apiKey || !channelId) return res.status(400).json({ error: "Missing params" });
  try {
    const cr = await fetch(`${YT}/channels?part=contentDetails&id=${channelId}&key=${apiKey}`);
    const cd = await cr.json();
    if (cd.error) return res.status(400).json({ error: cd.error.message });
    const uploadsId = cd.items[0].contentDetails.relatedPlaylists.uploads;
    const pr = await fetch(`${YT}/playlistItems?part=contentDetails&playlistId=${uploadsId}&maxResults=50&key=${apiKey}`);
    const pd = await pr.json();
    if (!pd.items?.length) return res.json({ items: [] });
    const ids = pd.items.map(i => i.contentDetails.videoId).join(",");
    const vr = await fetch(`${YT}/videos?part=snippet,statistics,contentDetails&id=${ids}&key=${apiKey}`);
    const vd = await vr.json();
    if (vd.error) return res.status(400).json({ error: vd.error.message });
    res.json(vd);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/comments", async (req, res) => {
  const { apiKey, videoId } = req.query;
  if (!apiKey || !videoId) return res.status(400).json({ error: "Missing params" });
  try {
    const r = await fetch(`${YT}/commentThreads?part=snippet&videoId=${videoId}&maxResults=100&order=relevance&key=${apiKey}`);
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`ChannelIQ server running on port ${PORT}`));
