const express = require("express");
const { exec, spawn } = require("child_process");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

// Use user-specific yt-dlp path by default, allow override via env (YTDLP_PATH)
const YTDLP_BIN =
  process.env.YTDLP_PATH ||
  "C:\\ffmpeg-8.0.1-essentials_build\\bin\\yt-dlp.exe";

// Help yt-dlp YouTube extractor by enabling a JS runtime.
// Use `node` from PATH to avoid Windows path/space parsing issues.
const JS_RUNTIME_ARG = "node";

let progressClients = [];
let lastProgress = 0;

const app = express();
app.use(cors());
app.use(express.json());

// Ensure downloads directory exists for temporary files
const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

function formatSizeMB(bytes) {
  const n = Number(bytes);
  if (!n || !isFinite(n) || n <= 0) return "Unknown";
  const mb = n / (1024 * 1024);
  if (mb < 0.1) return "<0.1 MB";
  return `${mb.toFixed(1)} MB`;
}

// Serve static frontend from /public
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.post("/analyze", (req, res) => {
  const url = req.body.url;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing URL." });
  }

  const args = [
    "--skip-download",
    "--no-playlist",
    "--js-runtimes",
    JS_RUNTIME_ARG,
    "-J",
    url
  ];

  const yt = spawn(YTDLP_BIN, args, { windowsHide: true });

  let stdout = "";
  let stderr = "";
  const timeoutMs = 20000;
  const timeoutId = setTimeout(() => {
    yt.kill("SIGKILL");
  }, timeoutMs);

  yt.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  yt.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  yt.on("error", (err) => {
    clearTimeout(timeoutId);
    console.error("yt-dlp analyze spawn error:", err);
    return res.status(500).json({ error: "Failed to start yt-dlp process." });
  });

  yt.on("close", (code) => {
    clearTimeout(timeoutId);

    if (code !== 0) {
      const msg = stderr || `yt-dlp exited with code ${code}`;
      console.error("yt-dlp analyze error:", msg);

      if (msg.includes("is not recognized as an internal or external command")) {
        return res
          .status(500)
          .json({ error: "yt-dlp is not installed or not in PATH on this system." });
      }

      if (msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("timed out")) {
        return res
          .status(504)
          .json({ error: "Analysis took too long. Please try again or use a shorter URL." });
      }

      return res.status(500).json({ error: "Failed to analyze video." });
    }

    try {
      const data = JSON.parse(stdout);

      const rawFormats = Array.isArray(data.formats) ? data.formats : [];

      // Show only standard YouTube resolutions (map odd heights into these buckets)
      const targets = [
        { height: 144, label: "144p" },
        { height: 360, label: "360p" },
        { height: 720, label: "720p" },
        { height: 1080, label: "1080p" },
        { height: 1440, label: "2K" },
        { height: 2160, label: "4K" }
      ];

      const videoCandidates = rawFormats.filter((f) => {
        if (!f || !f.height) return false;
        if (!f.vcodec || f.vcodec === "none") return false; // video stream (can be video-only)
        if (f.ext === "mhtml" || f.protocol === "mhtml") return false;
        if (f.format_note && /storyboard/i.test(f.format_note)) return false;
        if (f.format && /storyboard/i.test(f.format)) return false;
        return true;
      });

      const simpleFormats = [];
      for (const t of targets) {
        // pick best format with height <= target (closest height first, then best bitrate)
        const candidates = videoCandidates.filter(
          (f) => typeof f.height === "number" && f.height <= t.height
        );
        if (!candidates.length) continue;

        candidates.sort((a, b) => {
          const ha = a.height || 0;
          const hb = b.height || 0;
          if (hb !== ha) return hb - ha; // closest (highest <= target)
          return (b.tbr || 0) - (a.tbr || 0); // then best bitrate
        });

        const best = candidates[0];
        const sizeBytes = best.filesize || best.filesize_approx;
        simpleFormats.push({
          label: t.label,
          quality: `${t.height}p`,
          height: t.height,
          type: "video",
          format_id: best.format_id,
          ext: best.ext,
          size:
            sizeBytes && isFinite(sizeBytes)
              ? (sizeBytes / (1024 * 1024)).toFixed(1) + " MB"
              : "Unknown"
        });
      }

      // Optional MP3 entry (best audio-only stream)
      const audioFormats = rawFormats.filter(
        (f) =>
          f &&
          f.acodec &&
          f.acodec !== "none" &&
          (!f.vcodec || f.vcodec === "none")
      );
      if (audioFormats.length) {
        audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
        const bestAudio = audioFormats[0];
        const aSizeBytes = bestAudio.filesize || bestAudio.filesize_approx;
        const aMb =
          aSizeBytes && isFinite(aSizeBytes)
            ? (aSizeBytes / (1024 * 1024)).toFixed(1) + " MB"
            : "Unknown";

        simpleFormats.push({
          label: "MP3",
          quality: "MP3",
          type: "audio",
          format_id: bestAudio.format_id || null,
          ext: "mp3",
          size: aMb
        });
      }

      const thumb =
        data.thumbnail ||
        (Array.isArray(data.thumbnails) && data.thumbnails.length
          ? data.thumbnails[data.thumbnails.length - 1].url
          : null);

      return res.json({
        id: data.id || data.display_id || null,
        title: data.title,
        thumbnail: thumb,
        duration: data.duration,
        formats: simpleFormats
      });
    } catch (e) {
      console.error("Failed to parse yt-dlp JSON:", e);
      return res.status(500).json({ error: "Failed to parse video metadata." });
    }
  });
});

// SSE endpoint for download progress (aliases)
function handleProgressStream(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  progressClients.push(res);

  req.on("close", () => {
    progressClients = progressClients.filter((r) => r !== res);
  });
}

app.get("/progress", handleProgressStream);
app.get("/download-progress", handleProgressStream);

function broadcastEvent(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  progressClients.forEach((res) => {
    res.write(payload);
  });
}

function closeAllProgressStreams() {
  // End all active SSE responses and clear list
  for (const res of progressClients) {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
  progressClients = [];
}

function broadcastProgress(progress) {
  // Prevent duplicate 100% events
  if (typeof progress === "number" && progress <= lastProgress) return;
  lastProgress = progress;
  broadcastEvent({ progress });
}

// Download endpoint - robust file-based download using yt-dlp
app.post("/download", (req, res) => {
  try {
    const body = req.body || {};

    // Support both the new `{ url, format_id }` shape and the old `{ url, format: { format_id } }`
    const url = body.url;
    const format_id =
      body.format_id ||
      (body.format && (body.format.format_id || body.format.id));
    const quality =
      body.quality ||
      (body.format && (body.format.quality || body.format.label));

    if (!url || (!format_id && !quality)) {
      return res
        .status(400)
        .json({ error: "Missing url or quality/format_id" });
    }

    function buildFormatSelector(q) {
      const qUpper = String(q || "").trim().toUpperCase();
      if (qUpper === "MP3") return "bestaudio";

      const m = String(q || "").match(/(\d{3,4})/);
      const height = m ? parseInt(m[1], 10) : NaN;
      if (!Number.isFinite(height)) return "bestvideo+bestaudio/best";

      return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
    }

    const selector = format_id ? String(format_id) : buildFormatSelector(quality);
    const isMp3 = String(quality || "").trim().toUpperCase() === "MP3";

    const args = isMp3
      ? [
          "-f",
          "bestaudio",
          "--js-runtimes",
          JS_RUNTIME_ARG,
          "-x",
          "--audio-format",
          "mp3",
          "-o",
          path.join(downloadsDir, "%(title)s.%(ext)s"),
          url
        ]
      : [
          "-f",
          selector,
          "--js-runtimes",
          JS_RUNTIME_ARG,
          "--merge-output-format",
          "mp4",
          "-o",
          path.join(downloadsDir, "%(title)s.%(ext)s"),
          url
        ];

    const ytdlp = spawn(YTDLP_BIN, args, { windowsHide: true });

    let stderr = "";
    lastProgress = 0;
  broadcastProgress(0);

    // We don't need stdout when writing to file for now
    ytdlp.stdout.on("data", () => {});

    // Parse real download progress from yt-dlp output
    ytdlp.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      console.error("yt-dlp:", text);

      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.includes("[download]")) continue;
        if (
          line.includes("Merging formats") ||
          line.includes("Deleting original file") ||
          line.includes("Destination") ||
          line.includes("Downloading webpage")
        ) {
          continue;
        }

        const match = line.match(/(\d+(?:\.\d+)?)%/);
        if (!match) continue;

        const percent = Math.floor(parseFloat(match[1]));
        if (!Number.isFinite(percent)) continue;
        if (percent <= lastProgress) continue;

        lastProgress = percent;
        broadcastProgress(percent);
      }
    });

    ytdlp.on("error", (err) => {
      console.error("Failed to start yt-dlp:", err);
      if (!res.headersSent) {
        return res.status(500).json({ error: "yt-dlp failed to start" });
      }
    });

    ytdlp.on("close", (code) => {
      if (code !== 0) {
        console.error("yt-dlp failed with code", code, "stderr:", stderr);
        if (!res.headersSent) {
        // Notify progress listeners and close SSE streams
        broadcastEvent({ error: "Download failed" });
        closeAllProgressStreams();
        return res.status(500).json({
            error: "yt-dlp failed",
            details: stderr
          });
        }
      broadcastEvent({ error: "Download failed" });
      closeAllProgressStreams();
        return;
      }

      // yt-dlp finished successfully; try to find newest file
    broadcastEvent({ progress: 100, status: "complete" });
    closeAllProgressStreams();
      let latestFileName;
      try {
        const files = fs.readdirSync(downloadsDir);
        if (!files.length) {
          return res
            .status(500)
            .json({ error: "Download file not found" });
        }

        latestFileName = files
          .map((file) => ({
            name: file,
            time: fs
              .statSync(path.join(downloadsDir, file))
              .mtime.getTime()
          }))
          .sort((a, b) => b.time - a.time)[0].name;
      } catch (e) {
        console.error("Failed to locate downloaded file:", e);
        if (!res.headersSent) {
          return res
            .status(500)
            .json({ error: "Download file not found" });
        }
        return;
      }

      const filePath = path.join(downloadsDir, latestFileName);
      res.download(filePath, latestFileName, (err) => {
        if (err) {
          console.error("Error sending file to client:", err);
        }
        // Best-effort cleanup; ignore errors
        fs.unlink(filePath, () => {});
      });
    });
  } catch (err) {
    console.error("Download route error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Download failed" });
    }
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});

