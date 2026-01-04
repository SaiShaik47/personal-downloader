const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 8080;

/**
 * Makes filename safe for HTTP headers + filesystems
 * Fixes: TypeError [ERR_INVALID_CHAR] in Content-Disposition
 */
function safeHeaderFilename(name) {
  let s = String(name || "file")
    .replace(/[\r\n]/g, " ")          // remove newlines
    .replace(/[\x00-\x1F\x7F]/g, "")  // remove control chars
    .trim();

  // replace risky characters
  s = s.replace(/[<>:"/\\|?*]/g, "_");

  // shorten
  if (s.length > 120) s = s.slice(0, 120);

  if (!s) s = "file";
  return s;
}

// Simple health check
app.get("/health", (req, res) => res.status(200).send("ok"));

// Help page
app.get("/", (req, res, next) => {
  if (req.query.url || req.query.key || req.query.format) return next();

  res.setHeader("Content-Type", "text/plain");
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
      "Health check:",
      "/health"
    ].join("\n")
  );
});

// Download endpoint (same path "/")
app.get("/", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    const key = String(req.query.key || "");
    const format = String(req.query.format || "mp4").toLowerCase();

    // 1) KEY must exist in Railway variables
    if (!process.env.KEY) {
      return res.status(500).send("Server missing KEY variable in Railway.");
    }

    // 2) Check key
    if (key !== process.env.KEY) {
      return res.status(401).send("❌ WRONG KEY");
    }

    // 3) Check URL
    if (!url.startsWith("http")) {
      return res
        .status(400)
        .send("❌ Bad or missing url. Use ?url=https://...");
    }

    // 4) format: mp4/mp3
    if (!["mp4", "mp3"].includes(format)) {
      return res.status(400).send("❌ format must be mp4 or mp3");
    }

    // 5) Temp folder
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-"));
    const outTemplate = path.join(tmpDir, "%(title)s.%(ext)s");

    // 6) yt-dlp args
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

    // 7) Run yt-dlp
    const ytdlp = spawn("yt-dlp", args, { stdio: ["ignore", "ignore", "pipe"] });

    let errText = "";
    ytdlp.stderr.on("data", (d) => (errText += d.toString()));

    // If client closes connection early, stop download + cleanup
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        // stop yt-dlp if still running
        ytdlp.kill("SIGKILL");
      } catch {}
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    };

    res.on("close", cleanup);
    res.on("error", cleanup);

    ytdlp.on("close", (code) => {
      if (code !== 0) {
        cleanup();
        return res
          .status(500)
          .send("❌ Download failed:\n" + errText.slice(-1500));
      }

      // 8) Find output file
      const files = fs.readdirSync(tmpDir);
      const picked = files.find((f) => f.toLowerCase().endsWith(expectedExt));

      if (!picked) {
        cleanup();
        return res.status(500).send("❌ Output file not found");
      }

      const filePath = path.join(tmpDir, picked);

      // 9) SAFE filename for header (fixes your crash)
      const cleanName = safeHeaderFilename(picked);

      // 10) Send file
      res.setHeader("Content-Disposition", `attachment; filename="${cleanName}"`);
      res.setHeader(
        "Content-Type",
        format === "mp4" ? "video/mp4" : "audio/mpeg"
      );

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

      stream.on("close", cleanup);
      stream.on("error", cleanup);
    });
  } catch (e) {
    return res.status(500).send("Server error: " + String(e.message || e));
  }
});

// IMPORTANT: bind to 0.0.0.0 for Railway
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
