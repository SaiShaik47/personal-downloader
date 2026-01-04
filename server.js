const express = require("express");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 8080;

// Health check (test this first)
app.get("/health", (req, res) => res.status(200).send("ok"));

// Home help page
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(
    [
      "Personal yt-dlp Downloader (Direct Link)",
      "",
      "Use direct download:",
      "/d?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp4",
      "/d?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp3",
      "",
      "Optional quality filter (height in px, e.g. 720):",
      "/d?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp4&quality=720",
      "",
      "Get direct media URLs (no download):",
      "/url?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp4",
      "/url?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp4&quality=720",
      "Includes separate audio/video URLs plus a merged (progressive) link when available.",
      "",
      "Example:",
      "/d?url=https://www.youtube.com/watch?v=VIDEO_ID&key=12345&format=mp3",
      "",
      "Health:",
      "/health"
    ].join("\n")
  );
});

// Direct download endpoint
const buildFormatString = (format, quality) => {
  if (format === "mp3") {
    return null; // audio-only handled separately
  }

  // Prefer a specific height when provided, but still merge best video + audio.
  if (quality) {
    const h = Number(quality);
    if (!Number.isNaN(h) && h > 0) {
      // pick best video up to requested height, merged with best audio, fallback to best mp4
      return `bv*[height<=${h}]+ba/b[height<=${h}]/best`; // b = merged format fallback
    }
  }

  // default best available video+audio
  return "bv*+ba/best";
};

const runYtDlpJson = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(err || `yt-dlp exited with code ${code}`));
      }

      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error("Failed to parse yt-dlp JSON output"));
      }
    });
  });

const extractUrls = (info, format) => {
  if (Array.isArray(info?.requested_formats) && info.requested_formats.length) {
    return info.requested_formats
      .filter((f) => f.url)
      .map((f) => ({
        type: f.vcodec !== "none" ? "video" : "audio",
        url: f.url,
        ext: f.ext,
        height: f.height,
        abr: f.abr,
        formatId: f.format_id
      }));
  }

  if (info?.url) {
    return [
      {
        type: format === "mp3" ? "audio" : "video",
        url: info.url,
        ext: info.ext,
        height: info.height,
        abr: info.abr,
        formatId: info.format_id
      }
    ];
  }

  return [];
};

const pickMergedStream = (info, quality) => {
  if (!Array.isArray(info?.formats)) return null;

  const h = Number(quality);
  const maxHeight = !Number.isNaN(h) && h > 0 ? h : null;

  const progressive = info.formats.filter(
    (f) => f.url && f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none"
  );

  const heightMatch = progressive.filter((f) => (maxHeight ? f.height <= maxHeight : true));
  const candidates = heightMatch.length ? heightMatch : progressive;

  if (!candidates.length) return null;

  const best = candidates.reduce((acc, cur) => {
    if (!acc) return cur;
    const accHeight = acc.height || 0;
    const curHeight = cur.height || 0;
    return curHeight > accHeight ? cur : acc;
  }, null);

  if (!best) return null;

  return {
    type: "merged",
    url: best.url,
    ext: best.ext,
    height: best.height,
    fps: best.fps,
    formatId: best.format_id
  };
};

app.get("/d", (req, res) => {
  const url = String(req.query.url || "");
  const key = String(req.query.key || "");
  const format = String(req.query.format || "mp4").toLowerCase();
  const quality = req.query.quality;

  // KEY check
  if (!process.env.KEY) return res.status(500).send("Missing KEY in Railway Variables.");
  if (key !== process.env.KEY) return res.status(401).send("❌ WRONG KEY");

  // URL check
  if (!url.startsWith("http")) return res.status(400).send("❌ Missing or bad url.");

  // format check
  if (!["mp3", "mp4"].includes(format)) return res.status(400).send("❌ format must be mp3 or mp4");

  // ✅ Safe filename (ASCII only) to avoid Content-Disposition crash
  const downloadName = format === "mp3" ? "download.mp3" : "download.mp4";
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
  res.setHeader("Content-Type", format === "mp3" ? "audio/mpeg" : "video/mp4");

  // yt-dlp output goes directly to response (no temp files)
  // This is the "best direct download" method.
  const args =
    format === "mp3"
      ? [
          "--no-playlist",
          "-x",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "0",
          "-o",
          "-", // output to stdout
          url
        ]
      : [
          "--no-playlist",
          "-f",
          buildFormatString(format, quality),
          "--merge-output-format",
          "mp4",
          "-o",
          "-", // output to stdout
          url
        ];

  const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

  // pipe video/audio bytes to the client
  p.stdout.pipe(res);

  let err = "";
  p.stderr.on("data", (d) => (err += d.toString()));

  p.on("close", (code) => {
    if (code !== 0) {
      // If it failed early and headers already sent, we just end.
      if (!res.headersSent) res.status(500).send("❌ Download failed");
      try { res.end(); } catch {}
    }
  });

  // If user cancels download, kill yt-dlp
  req.on("close", () => {
    try { p.kill("SIGKILL"); } catch {}
  });
});

app.get("/url", async (req, res) => {
  const url = String(req.query.url || "");
  const key = String(req.query.key || "");
  const format = String(req.query.format || "mp4").toLowerCase();
  const quality = req.query.quality;

  if (!process.env.KEY) return res.status(500).send("Missing KEY in Railway Variables.");
  if (key !== process.env.KEY) return res.status(401).send("❌ WRONG KEY");
  if (!url.startsWith("http")) return res.status(400).send("❌ Missing or bad url.");
  if (!["mp3", "mp4"].includes(format)) return res.status(400).send("❌ format must be mp3 or mp4");

  const args =
    format === "mp3"
      ? ["--no-playlist", "-f", "bestaudio", "--dump-single-json", url]
      : ["--no-playlist", "-f", buildFormatString(format, quality), "--dump-single-json", url];

  try {
    const info = await runYtDlpJson(args);
    const urls = extractUrls(info, format);
    const merged = format === "mp4" ? pickMergedStream(info, quality) : null;

    if (!urls.length) return res.status(500).send("❌ Could not resolve media URLs");

    res.json({
      title: info.title,
      webpage_url: info.webpage_url,
      format,
      quality: quality || "best",
      urls,
      merged
    });
  } catch (e) {
    res.status(500).send(`❌ ${e.message}`);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
