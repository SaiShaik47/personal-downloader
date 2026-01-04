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

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
