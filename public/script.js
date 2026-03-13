const analyzeForm = document.getElementById("analyze-form");
const analyzeBtn = document.getElementById("analyze-btn");
const urlInput = document.getElementById("video-url");
const detectedPlatformEl = document.getElementById("detected-platform");
const detectedPlatformValueEl = document.getElementById("detected-platform-value");

const resultsCard = document.getElementById("results-card");
const thumbnailImg = document.getElementById("video-thumbnail");
const thumbPlaceholder = document.getElementById("thumb-placeholder");
const titleEl = document.getElementById("video-title");
const durationEl = document.getElementById("video-duration");
const formatsListEl = document.getElementById("formats-list");
const downloadBtn = document.getElementById("download-btn");
const progressContainer = document.getElementById("progress-container");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const progressPercent = document.getElementById("progress-percent");
const progressMetaEl = document.getElementById("progress-meta");
const progressMetaPercentEl = document.getElementById("progress-meta-percent");
const progressMetaSpeedEl = document.getElementById("progress-meta-speed");
const progressMetaEtaEl = document.getElementById("progress-meta-eta");

let currentFormats = [];
let selectedFormat = null;
let currentUrl = null;
let currentTitle = "";
let progressSource = null;
let downloadPhase = "idle"; // "server" | "browser" | "done"

function detectPlatform(url) {
  const s = String(url || "").toLowerCase();
  if (!s) return null;
  if (s.includes("youtube.com") || s.includes("youtu.be")) return "YouTube";
  if (s.includes("instagram.com")) return "Instagram";
  if (s.includes("facebook.com") || s.includes("fb.watch")) return "Facebook";
  if (s.includes("twitter.com") || s.includes("x.com")) return "Twitter";
  return "Universal";
}

function updateDetectedPlatform() {
  const p = detectPlatform(urlInput.value.trim());
  if (!p) {
    detectedPlatformEl.hidden = true;
    detectedPlatformValueEl.textContent = "";
    return;
  }
  detectedPlatformEl.hidden = false;
  detectedPlatformValueEl.textContent = p;
}

function formatBytesPerSecond(bps) {
  if (!bps || !isFinite(bps) || bps <= 0) return "0 MB/s";
  const mbps = bps / (1024 * 1024);
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  const kbps = bps / 1024;
  return `${kbps.toFixed(0)} KB/s`;
}

function formatEta(seconds) {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return "ETA --:--";
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `ETA ${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function setProgress(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  progressBar.style.width = `${clamped}%`;
  progressPercent.textContent = `${clamped}%`;
  if (clamped < 100) {
    progressText.textContent = `Downloading… ${clamped}%`;
  } else {
    progressText.textContent = "Download completed";
  }

  if (progressMetaEl) {
    progressMetaEl.hidden = false;
    if (progressMetaPercentEl) progressMetaPercentEl.textContent = `${clamped}%`;
  }
}

function setButtonLoading(btn, isLoading) {
  if (isLoading) {
    btn.classList.add("loading");
    btn.disabled = true;
  } else {
    btn.classList.remove("loading");
  }
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const s = Number(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m ${r}s`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function renderFormats(formats) {
  formatsListEl.innerHTML = "";
  selectedFormat = null;
  downloadBtn.disabled = true;

  formats.forEach((fmt, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card-format";

    const main = document.createElement("div");
    main.className = "card-format-main";
    main.textContent = fmt.label || fmt.resolution || (fmt.height ? `${fmt.height}p` : "Format");

    const sizeEl = document.createElement("div");
    sizeEl.className = "format-size";
    sizeEl.textContent = fmt.size || "";

    const sub = document.createElement("div");
    sub.className = "card-format-sub";
    sub.textContent = fmt.type === "audio" ? "Audio (MP3)" : "Video";

    card.appendChild(main);
    card.appendChild(sizeEl);
    card.appendChild(sub);

    card.addEventListener("click", () => {
      document.querySelectorAll(".card-format.selected").forEach((el) => {
        el.classList.remove("selected");
      });
      card.classList.add("selected");
      selectedFormat = fmt;
      downloadBtn.disabled = false;
    });

    if (index === 0) {
      card.classList.add("selected");
      selectedFormat = fmt;
      downloadBtn.disabled = false;
    }

    formatsListEl.appendChild(card);
  });
}

async function analyzeUrl(event) {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!url) return;

  setButtonLoading(analyzeBtn, true);
  resultsCard.hidden = true;
  if (thumbnailImg) thumbnailImg.style.display = "none";
  if (thumbPlaceholder) thumbPlaceholder.style.display = "grid";

  try {
    const resp = await fetch("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    if (!resp.ok) {
      let message = "Failed to analyze video.";
      try {
        const text = await resp.text();
        const json = JSON.parse(text);
        if (json && json.error) message = json.error;
      } catch {
        // ignore parse errors, use default message
      }
      throw new Error(message);
    }

    const data = await resp.json();
    currentFormats = data.formats || [];
    currentUrl = url;
    currentTitle = data.title || "";

    let thumb = data.thumbnail || "";
    if (!thumb && data.id) {
      thumb = `https://img.youtube.com/vi/${data.id}/maxresdefault.jpg`;
    }
    if (!thumb) {
      try {
        const u = new URL(url);
        const v = u.searchParams.get("v");
        if (v) {
          thumb = `https://img.youtube.com/vi/${v}/maxresdefault.jpg`;
        }
      } catch {
        // ignore URL parse errors
      }
    }

    thumbnailImg.src = thumb || "";
    thumbnailImg.style.display = thumb ? "block" : "none";
    if (thumbPlaceholder) thumbPlaceholder.style.display = thumb ? "none" : "grid";

    titleEl.textContent = data.title || "Untitled video";
    durationEl.textContent = data.duration
      ? `Duration: ${formatDuration(data.duration)}`
      : "";

    renderFormats(currentFormats);
    resultsCard.hidden = false;
  } catch (err) {
    console.error(err);
    alert(err.message || "Failed to analyze video.");
  } finally {
    setButtonLoading(analyzeBtn, false);
  }
}

analyzeForm.addEventListener("submit", analyzeUrl);
urlInput.addEventListener("input", updateDetectedPlatform);
updateDetectedPlatform();

urlInput.addEventListener("paste", () => {
  setTimeout(() => {
    const value = urlInput.value.trim();
    updateDetectedPlatform();
    if (value) {
      analyzeForm.requestSubmit();
    }
  }, 0);
});

async function startDownload() {
  if (!currentUrl || !selectedFormat) return;

  setButtonLoading(downloadBtn, true);
  progressContainer.hidden = false;
  downloadPhase = "server";
  progressBar.style.width = "0%";
  progressPercent.textContent = "0%";
  progressText.textContent = "Preparing download…";
  if (progressMetaEl) {
    progressMetaEl.hidden = true;
    if (progressMetaPercentEl) progressMetaPercentEl.textContent = "0%";
    if (progressMetaSpeedEl) progressMetaSpeedEl.textContent = "0 MB/s";
    if (progressMetaEtaEl) progressMetaEtaEl.textContent = "ETA --:--";
  }

  if (progressSource) {
    progressSource.close();
    progressSource = null;
  }

  progressSource = new EventSource("/download-progress");
  progressSource.onmessage = (event) => {
    if (downloadPhase !== "server") return;
    try {
      const data = JSON.parse(event.data);
      if (typeof data.progress === "number") {
        const pct = Math.max(0, Math.min(100, data.progress));
        setProgress(pct);
      }
    } catch {
      // ignore parse errors
    }
  };

  try {
    const body = {
      url: currentUrl,
      format: {
        ...selectedFormat,
        title: currentTitle
      }
    };

    const resp = await fetch("/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      try {
        const json = JSON.parse(text);
        throw new Error(json.error || "Download failed.");
      } catch {
        throw new Error("Download failed.");
      }
    }

    // Switch to browser download phase
    downloadPhase = "browser";
    if (progressSource) {
      progressSource.close();
      progressSource = null;
    }

    const contentLengthHeader = resp.headers.get("Content-Length");
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

    if (!resp.body || !window.ReadableStream || !resp.body.getReader || !contentLength) {
      // Fallback: no streaming support or unknown length
      const blob = await resp.blob();
      setProgress(100);

      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      const isAudio = selectedFormat.type === "audio" || selectedFormat.label === "MP3";
      const ext = isAudio ? "mp3" : "mp4";
      const safeTitle =
        (currentTitle || "shreytube-download").replace(/[<>:\"/\\|?*]+/g, "").trim() ||
        "shreytube-download";
      link.href = url;
      link.download = `${safeTitle}.${ext}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } else {
      const reader = resp.body.getReader();
      let receivedLength = 0;
      const chunks = [];
      const startMs = performance.now();
      let lastSampleMs = startMs;
      let lastSampleBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;

        const percent = Math.floor((receivedLength / contentLength) * 100);
        setProgress(percent);

        const nowMs = performance.now();
        const dt = (nowMs - lastSampleMs) / 1000;
        if (dt >= 0.4) {
          const dBytes = receivedLength - lastSampleBytes;
          const bps = dBytes / dt;
          const remainingBytes = Math.max(0, contentLength - receivedLength);
          const etaSeconds = bps > 0 ? remainingBytes / bps : 0;
          if (progressMetaSpeedEl) progressMetaSpeedEl.textContent = formatBytesPerSecond(bps);
          if (progressMetaEtaEl) progressMetaEtaEl.textContent = formatEta(etaSeconds);
          lastSampleMs = nowMs;
          lastSampleBytes = receivedLength;
        }
      }

      // Merge chunks into a single Blob
      const blob = new Blob(chunks);

      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      const isAudio = selectedFormat.type === "audio" || selectedFormat.label === "MP3";
      const ext = isAudio ? "mp3" : "mp4";
      const safeTitle =
        (currentTitle || "shreytube-download").replace(/[<>:\"/\\|?*]+/g, "").trim() ||
        "shreytube-download";
      link.href = url;
      link.download = `${safeTitle}.${ext}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }

    downloadPhase = "done";
    setProgress(100);
  } catch (err) {
    console.error(err);
    alert(err.message || "Download failed.");
  } finally {
    setButtonLoading(downloadBtn, false);
    downloadBtn.disabled = false;
    if (progressSource) {
      progressSource.close();
      progressSource = null;
    }
  }
}

downloadBtn.addEventListener("click", startDownload);

