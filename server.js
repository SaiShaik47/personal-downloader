const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

// ---- Simple in-memory job store (works on one Railway instance) ----
const jobs = new Map(); // id -> { status, format, tmpDir, filePath, progress, error, createdAt }
const JOB_TTL_MS = 15 * 60 * 1000; // 15 minutes

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      try { if (job.tmpDir) fs.rmSync(job.tmpDir, { recursive: true, force: true }); } catch {}
      jobs.delete(id);
    }
  }
}
setInterval(cleanupOldJobs, 60_000).unref();

function requireKey(req, res) {
  const key = String(req.query.key || "");
  if (!process.env.KEY) {
    res.status(500).send("Server missing KEY in Railway Variables.");
    return false;
  }
  if (key !== process.env.KEY) {
    res.status(401).send("❌ WRONG KEY");
    return false;
  }
  return true;
}

// Health
app.get("/health", (req, res) => res.status(200).send("ok"));

// Home instructions
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(
    [
      "Personal yt-dlp Downloader (Railway) with Progress",
      "",
      "1) Start a download job:",
      "   /create?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp3",
      "   /create?url=YOUTUBE_LINK&key=YOUR_KEY&format=mp4",
      "",
      "2) Watch live progress (SSE):",
      "   /progress?id=JOB_ID&key=YOUR_KEY",
      "",
      "3) Download when ready:",
      "   /download?id=JOB_ID&key=YOUR_KEY",
      "",
      "Health: /health"
    ].join("\n")
  );
});

/**
 * STEP A: Create a job
 * GET /create?url=...&key=...&format=mp3|mp4
 * returns JSON: { id, progressUrl, downloadUrl }
 */
app.get("/create", (req, res) => {
  if (!requireKey(req, res)) return;

  const url = String(req.query.url || "");
  const format = String(req.query.format || "mp4").toLowerCase();

  if (!url.startsWith("http")) {
    return res.status(400).json({ success: false, error: "Bad or missing url" });
  }
  if (!["mp3", "mp4"].includes(format)) {
    return res.status(400).json({ success: false, error: "format must be mp3 or mp4" });
  }

  const id = crypto.randomBytes(8).toString("hex");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ytdlp-${id}-`));
  const outTemplate = path.join(tmpDir, "output.%(ext)s");

  const job = {
    id,
    status: "running", // running | done | error
    format,
    tmpDir,
    filePath: null,
    progress: "Starting...",
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);

  // yt-dlp progress output:
  // We capture stderr because yt-dlp prints progress there often.
  let args = [];
  if (format === "mp4") {
    args = [
      "--newline",
      "-f", "bv*+ba/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "-o", outTemplate,
      url
    ];
  } else {
    args = [
      "--newline",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--no-playlist",
      "-o", outTemplate,
      url
    ];
  }

  const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

  const onLine = (line) => {
    const text = String(line || "").trim();
    if (!text) return;
    // Store last progress line
    job.progress = text;
  };

  p.stdout.on("data", (d) => onLine(d.toString()));
  p.stderr.on("data", (d) => onLine(d.toString()));

  p.on("close", (code) => {
    if (code !== 0) {
      job.status = "error";
      job.error = job.progress || "Download failed";
      return;
    }
    // find output file
    const files = fs.readdirSync(tmpDir);
    const picked = files.find(f => format === "mp4" ? f.toLowerCase().endsWith(".mp4") : f.toLowerCase().endsWith(".mp3"));
    if (!picked) {
      job.status = "error";
      job.error = "Output file not found";
      return;
    }
    job.filePath = path.join(tmpDir, picked);
    job.status = "done";
    job.progress = "Done ✅";
  });

  // Build URLs
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    success: true,
    id,
    progressUrl: `${base}/progress?id=${id}&key=${encodeURIComponent(req.query.key)}`,
    downloadUrl: `${base}/download?id=${id}&key=${encodeURIComponent(req.query.key)}`
  });
});

/**
 * STEP B: Live progress using Server-Sent Events (SSE)
 * Open in browser or EventSource:
 * GET /progress?id=...&key=...
 */
app.get("/progress", (req, res) => {
  if (!requireKey(req, res)) return;

  const id = String(req.query.id || "");
  const job = jobs.get(id);
  if (!job) return res.status(404).send("Job not found");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Send initial
  send({ id, status: job.status, progress: job.progress });

  const timer = setInterval(() => {
    if (!jobs.has(id)) {
      send({ id, status: "expired", progress: "Expired" });
      clearInterval(timer);
      return res.end();
    }
    send({ id, status: job.status, progress: job.progress, error: job.error });

    if (job.status === "done" || job.status === "error") {
      clearInterval(timer);
      // keep connection a tiny bit then end
      setTimeout(() => res.end(), 500);
    }
  }, 700);

  req.on("close", () => clearInterval(timer));
});

/**
 * STEP C: Direct download URL
 * GET /download?id=...&key=...
 */
app.get("/download", (req, res) => {
  if (!requireKey(req, res)) return;

  const id = String(req.query.id || "");
  const job = jobs.get(id);
  if (!job) return res.status(404).send("Job not found");

  if (job.status === "running") {
    return res.status(425).send("Still downloading. Check /progress");
  }
  if (job.status === "error") {
    return res.status(500).send("Job failed: " + (job.error || "unknown error"));
  }
  if (!job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(500).send("File missing (job expired or cleaned). Start again.");
  }

  // Use super-safe filename to avoid header crashes forever
  const downloadName = job.format === "mp4" ? "download.mp4" : "download.mp3";

  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
  res.setHeader("Content-Type", job.format === "mp4" ? "video/mp4" : "audio/mpeg");

  const stream = fs.createReadStream(job.filePath);
  stream.pipe(res);

  // After download, cleanup job
  const cleanup = () => {
    try { fs.rmSync(job.tmpDir, { recursive: true, force: true }); } catch {}
    jobs.delete(id);
  };
  stream.on("close", cleanup);
  stream.on("error", cleanup);
  res.on("close", cleanup);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
