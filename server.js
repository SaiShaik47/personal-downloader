const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 8080;

// Health check
app.get("/health", (req, res) => res.status(200).send("ok"));

// Help page if no query params
app.get("/", (req, res, next) => {
  if (req.query.url || req.query.key || req.query.format) return next();

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(
    [
      "Personal yt-dlp Downloader (MP4/MP3)",
      "",
      "Use:",
      "/?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp4",
      "/?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp3",
      "",
      "Example:",
      "/?url=https://www.youtube.com/watch?v=VIDEO_ID&key=12345&format=mp3",
      "",
      "Health:",
      "/health"
    ].join("\n")
  );
});

// Downloader (same "/")
app.get("/", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    const key = String(req.query.key || "");
    const format = String(req.query.format || "mp4").toLowerCase();

    // KEY must exist in Railway Variables
    if (!process.env.KEY) {
      return res.status(500).send("Server missing KEY variable in Railway.");
    }

    // Check key
    if (key !== process.env.KEY) {
      return res.status(401).send("❌ WRONG KEY");
    }

    // Check URL
    if (!url.startsWith("http")) {
      return res.status(400).send("❌ Bad or missing url. Use ?url=https://...");
    }

    // Check format
    if (!["mp4", "mp3"].includes(format)) {
      return res.status(400).send("❌ format must be mp4 or mp3");
    }

    // Temp folder
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-"));
    const outTemplate = path.join(tmpDir, "output.%(ext)s");

    // yt-dlp args
    let args = [];
    let expectedExt = "";

    if (format === "mp4") {
      expectedExt = ".mp4";
      args = [
        "-f",
        "bv*+ba/best",
        "--merge-output-format",
        "mp4",
        "--no-playlist",
        "-o",
        outTemplate,
        url
      ];
    } else {
      expectedExt = ".mp3";
      args = [
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--no-playlist",
        "-o",
        outTemplate,
        url
      ];
    }

    const ytdlp = spawn("yt-dlp", args, { stdio: ["ignore", "ignore", "pipe"] });

    let errText = "";
    ytdlp.stderr.on("data", (d) => (errText += d.toString()));

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { ytdlp.kill("SIGKILL"); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    };

    res.on("close", cleanup);
    res.on("error", cleanup);

    ytdlp.on("close", (code) => {
      if (code !== 0) {
        cleanup();
        return res.status(500).send("❌ Download failed:\n" + errText.slice(-1500));
      }

      // Find output file
      const files = fs.readdirSync(tmpDir);
      const picked = files.find((f) => f.toLowerCase().endsWith(expectedExt));

      if (!picked) {
        cleanup();
        return res.status(500).send("❌ Output file not found");
      }

      const filePath = path.join(tmpDir, picked);

      // ✅ SUPER SAFE filename (ASCII only) to avoid header crash forever
      const downloadName = format === "mp4" ? "download.mp4" : "download.mp3";

      res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
      res.setHeader("Content-Type", format === "mp4" ? "video/mp4" : "audio/mpeg");

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

      stream.on("close", cleanup);
      stream.on("error", cleanup);
    });
  } catch (e) {
    res.status(500).send("Server error: " + String(e.message || e));
  }
});

// Bind to 0.0.0.0 for Railway
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
