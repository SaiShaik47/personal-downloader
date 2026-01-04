const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();

// Railway gives PORT automatically
const PORT = process.env.PORT || 8080;

// Home page (help)
app.get("/", (req, res, next) => {
  // If user is calling with url+key, handle download route
  if (req.query.url || req.query.key || req.query.format) return next();

  res.setHeader("Content-Type", "text/plain");
  res.send(
    [
      "Personal yt-dlp Downloader",
      "",
      "Use:",
      "/?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp4",
      "/?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp3",
      "",
      "Example:",
      "/?url=https://www.youtube.com/watch?v=VIDEO_ID&key=12345&format=mp3"
    ].join("\n")
  );
});

// Download endpoint (same path "/")
app.get("/", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    const key = String(req.query.key || "");
    const format = String(req.query.format || "mp4").toLowerCase();

    // 1) Check API key
    if (!process.env.KEY) {
      return res.status(500).send("Server missing KEY variable in Railway.");
    }
    if (key !== process.env.KEY) {
      return res.status(401).send("❌ WRONG KEY");
    }

    // 2) Check URL
    if (!url.startsWith("http")) {
      return res.status(400).send("❌ Bad or missing url. Use ?url=https://...");
    }

    // 3) Format: mp4 or mp3
    if (!["mp4", "mp3"].includes(format)) {
      return res.status(400).send("❌ format must be mp4 or mp3");
    }

    // 4) Temp folder
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-"));
    const outTemplate = path.join(tmpDir, "%(title)s.%(ext)s");

    // 5) yt-dlp arguments
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

    // 6) Run yt-dlp
    const ytdlp = spawn("yt-dlp", args, { stdio: ["ignore", "ignore", "pipe"] });

    let errText = "";
    ytdlp.stderr.on("data", (d) => (errText += d.toString()));

    ytdlp.on("close", (code) => {
      if (code !== 0) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        return res.status(500).send("❌ Download failed:\n" + errText.slice(-1500));
      }

      // 7) Find output file
      const files = fs.readdirSync(tmpDir);
      const picked = files.find((f) => f.toLowerCase().endsWith(expectedExt));

      if (!picked) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        return res.status(500).send("❌ Output file not found");
      }

      const filePath = path.join(tmpDir, picked);

      // 8) Send file to browser
      res.setHeader("Content-Disposition", `attachment; filename="${picked}"`);
      res.setHeader("Content-Type", format === "mp4" ? "video/mp4" : "audio/mpeg");

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

      // 9) Cleanup after download
      const cleanup = () => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      };
      stream.on("close", cleanup);
      stream.on("error", cleanup);
      res.on("close", cleanup);
    });
  } catch (e) {
    res.status(500).send("Server error: " + String(e.message || e));
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
