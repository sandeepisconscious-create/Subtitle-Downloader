// @ts-check
/**
 * Page-Context (MAIN World) Universal Subtitle Interceptor & Harvester.
 * Captures subtitles across OTT & video platforms via:
 *  1. window.fetch & XMLHttpRequest interception
 *  2. HTML5 <video>.textTracks & TextTrack.prototype.addCue hook
 *  3. <track src="..."> DOM elements & embedded player state
 *  4. Live caption overlay DOM observer
 *  5. In-page authenticated URL & HLS .m3u8 segment stitcher
 */

(function () {
  if (window.__subDownloaderInstalled) return;
  window.__subDownloaderInstalled = true;

  const Config = window.SubConfig;
  const Parser = window.UniversalSubtitleParser;
  if (!Config || !Parser) return;

  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

  function postToBridge(payload) {
    window.postMessage({ __subDownloader: true, ...payload }, "*");
  }

  /**
   * Inspect an intercepted response body (text, JSON, or fMP4 ArrayBuffer).
   * @param {string} url
   * @param {string} contentType
   * @param {string | ArrayBuffer | object} rawBody
   */
  async function inspectPayload(url, contentType, rawBody) {
    try {
      if (!rawBody) return;

      if (typeof rawBody === "string" && rawBody.trim().startsWith("#EXTM3U")) {
        const m3u8 = Parser.inspectM3u8Manifest(rawBody, url);
        if (!m3u8) return;
        if (m3u8.type === "master") {
          for (const t of m3u8.subtitleTracks) {
            postToBridge({
              type: "TRACK_CAPTURED",
              track: {
                key: t.url,
                url: t.url,
                label: `${t.label} (HLS)`,
                lang: t.lang,
                format: "HLS",
                isHlsPlaylist: true,
                cues: []
              }
            });
          }
        } else if (m3u8.type === "media") {
          const meta = Config.inferTrackMetadata(url, "HLS", location.href);
          postToBridge({
            type: "TRACK_CAPTURED",
            track: {
              key: url,
              url,
              label: `${meta.label} (${m3u8.segments.length} segments)`,
              lang: meta.lang,
              format: "HLS",
              isHlsPlaylist: true,
              segments: m3u8.segments,
              cues: []
            }
          });
        }
        return;
      }

      const parsed = Parser.parseUniversalSubtitle(rawBody, url);
      if (parsed && parsed.cues && parsed.cues.length >= 1) {
        const key = Config.canonicalizeTrackUrl(url, location.href);
        const meta = Config.inferTrackMetadata(url, parsed.format || "SUB", location.href);
        postToBridge({
          type: "TRACK_CAPTURED",
          track: {
            key,
            url,
            label: meta.label,
            lang: meta.lang,
            format: parsed.format || "SUB",
            isHlsPlaylist: false,
            cues: parsed.cues
          }
        });
      }
    } catch (_) {}
  }

  // 1. Hook window.fetch
  if (origFetch) {
    window.fetch = function (...args) {
      let promise;
      try {
        promise = origFetch.apply(this, args);
      } catch (err) {
        throw err;
      }

      if (promise && typeof promise.then === "function") {
        promise
          .then((response) => {
            if (!response || !response.headers) return response;
            try {
              const reqUrl =
                typeof args[0] === "string"
                  ? args[0]
                  : args[0] && typeof args[0].url === "string"
                  ? args[0].url
                  : response.url || "";
              const fullUrl = reqUrl ? new URL(reqUrl, location.href).href : response.url;
              const ct = (response.headers && response.headers.get("content-type")) || "";
              const cl = parseInt((response.headers && response.headers.get("content-length")) || "0", 10);

              const isSmallTextOrProxy =
                cl <= Config.LIMITS.MAX_FETCH_BYTES &&
                (/text\/(vtt|srt|plain)|subrip|ttml/i.test(ct) ||
                  /\b(proxy|sub|subs|subtitle|subtitles|caption|captions|wyzie|opensubtitles|subdl|subsource)\b/i.test(
                    fullUrl
                  ));

              if (
                cl <= Config.LIMITS.MAX_FETCH_BYTES &&
                (Config.isLikelySubtitleRequest(fullUrl, ct) || isSmallTextOrProxy)
              ) {
                const clone = response.clone();
                (async () => {
                  try {
                    if (/\.(m4s|mp4|dash|cmft)(\?|$)/i.test(fullUrl) || /octet-stream|mp4/i.test(ct)) {
                      const buf = await clone.arrayBuffer();
                      if (buf && buf.byteLength <= Config.LIMITS.MAX_FMP4_BYTES) {
                        await inspectPayload(fullUrl, ct, buf);
                      }
                    } else {
                      const txt = await clone.text();
                      if (txt && txt.length <= Config.LIMITS.MAX_FETCH_BYTES) {
                        await inspectPayload(fullUrl, ct, txt);
                      }
                    }
                  } catch (_) {}
                })();
              }
            } catch (_) {}
            return response;
          })
          .catch(() => {
            // Intentionally silent: if the page's fetch was blocked by CSP, an ad blocker,
            // or network error, do not create an unhandled rejection in the extension's chain.
          });
      }

      return promise;
    };
  }

  // 2. Hook XMLHttpRequest
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__subUrl = url ? new URL(String(url), location.href).href : "";
    } catch (_) {
      this.__subUrl = String(url || "");
    }
    return origXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this.responseURL || this.__subUrl || "";
        const ct = this.getResponseHeader("content-type") || "";
        const isSmallTextOrProxy =
          /text\/(vtt|srt|plain)|subrip|ttml/i.test(ct) ||
          /\b(proxy|sub|subs|subtitle|subtitles|caption|captions|wyzie|opensubtitles|subdl|subsource)\b/i.test(url);
        if (!Config.isLikelySubtitleRequest(url, ct) && !isSmallTextOrProxy) return;

        if (this.responseType === "arraybuffer" && this.response instanceof ArrayBuffer) {
          if (this.response.byteLength <= Config.LIMITS.MAX_FMP4_BYTES) {
            inspectPayload(url, ct, this.response);
          }
        } else if (!this.responseType || this.responseType === "text") {
          const txt = this.responseText;
          if (txt && txt.length <= Config.LIMITS.MAX_FETCH_BYTES) {
            inspectPayload(url, ct, txt);
          }
        } else if (this.responseType === "json" && this.response) {
          inspectPayload(url, ct, this.response);
        }
      } catch (_) {}
    });
    return origXhrSend.apply(this, args);
  };

  // 2b. Hook URL.createObjectURL to capture Blob-based VTT/SRT subtitle tracks
  const scannedBlobUrls = new Set();
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (obj) {
      const blobUrl = origCreateObjectURL(obj);
      try {
        if (
          obj &&
          typeof Blob !== "undefined" &&
          obj instanceof Blob &&
          obj.size > 20 &&
          obj.size <= Config.LIMITS.MAX_FETCH_BYTES
        ) {
          const bType = String(obj.type || "").toLowerCase();
          if (!bType || /vtt|srt|subrip|ttml|xml|json|text\/plain|octet-stream/i.test(bType)) {
            scannedBlobUrls.add(blobUrl);
            obj
              .text()
              .then((txt) => {
                if (txt && txt.length <= Config.LIMITS.MAX_FETCH_BYTES) {
                  inspectPayload(blobUrl, bType || "text/vtt", txt);
                }
              })
              .catch(() => {});
          }
        }
      } catch (_) {}
      return blobUrl;
    };
  }

  // 3. Hook HTML5 TextTrack.prototype.addCue & Harvest <video>.textTracks
  const domTrackCues = new Map();
  const dirtyDomTracks = new Set();
  const reportedStaticKeys = new Set();
  const lastScannedCueLen = new WeakMap();
  let domFlushTimer = null;

  function reportStaticTrackOnce(track) {
    if (!track || !track.key) return;
    const sig = `${location.href}|${track.key}`;
    if (reportedStaticKeys.has(sig)) return;
    reportedStaticKeys.add(sig);
    postToBridge({ type: "TRACK_CAPTURED", track });
  }

  function recordDomCue(trackKey, label, lang, startSec, endSec, rawText, format = "TRACK") {
    const text = Parser.cleanCueText(rawText);
    if (!text) return;
    if (!domTrackCues.has(trackKey)) {
      domTrackCues.set(trackKey, { label, lang, format, map: new Map() });
    }
    const entry = domTrackCues.get(trackKey);
    if (entry.map.size >= Config.LIMITS.MAX_CUES_PER_TRACK) return;

    const s = Math.max(0, Number(startSec) || 0);
    const e = Number(endSec) > s ? Number(endSec) : s + 2.5;
    const cueKey = `${Math.round(s * 10)}_${text.slice(0, 40)}`;
    if (entry.map.has(cueKey)) return;

    entry.map.set(cueKey, { startSec: s, endSec: e, ts: Parser.secToBracket(s), text });
    dirtyDomTracks.add(trackKey);

    if (!domFlushTimer) {
      domFlushTimer = setTimeout(flushDomTracks, 600);
    }
  }

  function flushDomTracks(forceAll = false) {
    domFlushTimer = null;
    const keys = forceAll ? [...domTrackCues.keys()] : [...dirtyDomTracks];
    dirtyDomTracks.clear();
    for (const key of keys) {
      const entry = domTrackCues.get(key);
      if (!entry) continue;
      const cues = Parser.normalizeAndDedupeCues([...entry.map.values()]);
      if (cues.length >= 1) {
        postToBridge({
          type: "TRACK_CAPTURED",
          track: {
            key,
            url: key,
            label: entry.label,
            lang: entry.lang,
            format: entry.format,
            isHlsPlaylist: false,
            cues
          }
        });
      }
    }
  }

  if (typeof TextTrack !== "undefined" && TextTrack.prototype && TextTrack.prototype.addCue) {
    const origAddCue = TextTrack.prototype.addCue;
    TextTrack.prototype.addCue = function (cue) {
      try {
        if (cue && cue.text) {
          const lang = this.language || "und";
          const label = this.label || (lang !== "und" ? lang.toUpperCase() : "Video Track");
          const key = `texttrack://${location.host}${location.pathname}#${lang}_${label}`;
          recordDomCue(key, `${label} (Player Track)`, lang, cue.startTime, cue.endTime, cue.text, "TRACK");
        }
      } catch (_) {}
      return origAddCue.call(this, cue);
    };
  }

  function scanPagePlayerTracks(forceReport = false) {
    try {
      if (forceReport) reportedStaticKeys.clear();

      document.querySelectorAll("video track[src]").forEach((tr) => {
        const src = /** @type {HTMLTrackElement} */ (tr).src;
        if (!src) return;
        if (src.startsWith("blob:")) {
          if (!scannedBlobUrls.has(src)) {
            scannedBlobUrls.add(src);
            const fetchFn = origFetch || window.fetch.bind(window);
            fetchFn(src)
              .then((r) => r.text())
              .then((txt) => {
                if (txt && txt.length <= Config.LIMITS.MAX_FETCH_BYTES) {
                  inspectPayload(src, "text/vtt", txt);
                }
              })
              .catch(() => {});
          }
          return;
        }
        const lang = /** @type {HTMLTrackElement} */ (tr).srclang || "";
        const label = /** @type {HTMLTrackElement} */ (tr).label || lang || "Video Track";
        reportStaticTrackOnce({
          key: src,
          url: src,
          label,
          lang,
          format: "VTT",
          isHlsPlaylist: false,
          cues: []
        });
      });

      document.querySelectorAll("video").forEach((video) => {
        if (!video.textTracks) return;
        for (let i = 0; i < video.textTracks.length; i++) {
          const tt = video.textTracks[i];
          if (!tt || !tt.cues || tt.cues.length === 0) continue;
          const prevLen = lastScannedCueLen.get(tt) || 0;
          if (!forceReport && prevLen === tt.cues.length) continue;
          lastScannedCueLen.set(tt, tt.cues.length);

          const lang = tt.language || "und";
          const label = tt.label || (lang !== "und" ? lang.toUpperCase() : `Track ${i + 1}`);
          const key = `texttrack://${location.host}${location.pathname}#${lang}_${label}`;
          for (let j = 0; j < tt.cues.length; j++) {
            const c = /** @type {any} */ (tt.cues[j]);
            if (c && c.text) {
              recordDomCue(key, `${label} (Player Track)`, lang, c.startTime, c.endTime, c.text, "TRACK");
            }
          }
        }
      });

      // Harvest active YouTube timedtext URLs (with PO token) from Performance Resource Timing
      if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
        const resEntries = performance.getEntriesByType("resource") || [];
        for (let i = resEntries.length - 1; i >= Math.max(0, resEntries.length - 80); i--) {
          const entryUrl = resEntries[i] && resEntries[i].name;
          if (entryUrl && /youtube\.com\/api\/timedtext/i.test(entryUrl) && /[?&]pot=/i.test(entryUrl)) {
            const langM = entryUrl.match(/[?&]lang=([^&]+)/i);
            const kindM = entryUrl.match(/[?&]kind=([^&]+)/i);
            const lang = langM ? decodeURIComponent(langM[1]) : "en";
            const isAsr = kindM && /asr/i.test(kindM[1]);
            reportStaticTrackOnce({
              key: `yt_pot_${lang}_${isAsr ? "asr" : "manual"}`,
              url: entryUrl,
              label: `${lang.toUpperCase()}${isAsr ? " (auto)" : ""} · Player Stream`,
              lang,
              format: /[?&]fmt=json3/i.test(entryUrl) ? "JSON" : "XML",
              isHlsPlaylist: false,
              cues: []
            });
          }
        }
      }

      const ytTracks =
        window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(ytTracks)) {
        for (const t of ytTracks) {
          if (!t || !t.baseUrl) continue;
          const cleanUrl = t.baseUrl.replace(/&fmt=srv3/g, "");
          const name = (t.name && (t.name.simpleText || t.name.runs?.[0]?.text)) || t.languageCode || "Captions";
          reportStaticTrackOnce({
            key: `yt_track_${t.languageCode}_${t.kind || "manual"}`,
            url: cleanUrl,
            label: `${name}${t.kind === "asr" ? " (auto)" : ""}`,
            lang: t.languageCode || "en",
            format: "XML",
            isHlsPlaylist: false,
            cues: []
          });
        }
      }

      const ttData =
        window.__UNIVERSAL_DATA_FOR_REHYDRATION__?.["__DEFAULT_SCOPE__"]?.["webapp.video-detail"]?.itemInfo?.itemStruct
          ?.video?.claInfo?.captionInfos;
      if (Array.isArray(ttData)) {
        for (const c of ttData) {
          const subUrl = c?.url || (Array.isArray(c?.urlList) && c.urlList[0]);
          if (subUrl) {
            reportStaticTrackOnce({
              key: subUrl,
              url: subUrl,
              label: c.language || "Captions",
              lang: c.languageCode || c.language || "en",
              format: "VTT",
              isHlsPlaylist: false,
              cues: []
            });
          }
        }
      }
    } catch (_) {}
  }

  // 4. Live Caption Overlay Harvester
  const overlaySelectors = [
    ".player-timedtext-text-container",
    ".atvwebplayersdk-captions-text",
    ".shaka-text-container",
    ".dss-subtitle-renderer-cue",
    ".vjs-text-track-display",
    ".jw-text-track-cue",
    ".plyr__captions",
    ".ytp-caption-window-container"
  ].join(",");

  let lastOverlayText = "";
  setInterval(() => {
    try {
      if (document.hidden) return;
      const video = document.querySelector("video");
      if (!video && !window.ytInitialPlayerResponse && !window.__UNIVERSAL_DATA_FOR_REHYDRATION__) return;

      scanPagePlayerTracks(false);
      if (!video) return;

      const overlayNodes = document.querySelectorAll(overlaySelectors);
      if (!overlayNodes.length) return;
      const lines = [];
      overlayNodes.forEach((n) => {
        const t = (/** @type {HTMLElement} */ (n).innerText || "").trim();
        if (t) lines.push(t);
      });
      const combined = lines.join(" ").replace(/\s+/g, " ").trim();
      if (combined && combined !== lastOverlayText) {
        lastOverlayText = combined;
        const curSec = video.currentTime || 0;
        const key = `live_dom://${location.host}${location.pathname}`;
        recordDomCue(key, "Live Captions (Captured from Player)", "live", curSec, curSec + 3, combined, "LIVE");
      }
    } catch (_) {}
  }, 1500);

  // 5. Handle Commands from Bridge / Background
  async function stitchHlsManifestInPage(m3u8Text, baseUrl, fetchFn) {
    const info = Parser.inspectM3u8Manifest(m3u8Text, baseUrl);
    if (!info) return { ok: false, error: "Not a subtitle HLS playlist" };

    if (info.type === "master" && info.subtitleTracks.length > 0) {
      const firstSubUrl = info.subtitleTracks[0].url;
      const r = await fetchFn(firstSubUrl, { credentials: "include" });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status} fetching subtitle media playlist` };
      const subText = await r.text();
      return stitchHlsManifestInPage(subText, firstSubUrl, fetchFn);
    }

    if (info.type === "media" && info.segments.length > 0) {
      return Parser.stitchHlsSegments(info.segments, fetchFn, "include");
    }

    return { ok: false, error: "No subtitle segments found in HLS playlist" };
  }

  window.addEventListener("message", async (ev) => {
    const msg = ev.data;
    if (!msg || !msg.__subDownloaderCmd) return;

    if (msg.cmd === "SCAN_NOW") {
      scanPagePlayerTracks(true);
      flushDomTracks(true);
      postToBridge({ type: "CMD_RESPONSE", reqId: msg.reqId, ok: true });
      return;
    }

    const fetchFn = origFetch || window.fetch.bind(window);

    if (msg.cmd === "FETCH_AND_PARSE_URL") {
      try {
        const r = await fetchFn(msg.url, { credentials: "include" });
        if (!r.ok) {
          return postToBridge({ type: "CMD_RESPONSE", reqId: msg.reqId, ok: false, error: `HTTP ${r.status}` });
        }
        const ct = r.headers.get("content-type") || "";
        const payload =
          /\.(m4s|mp4|dash|cmft)(\?|$)/i.test(msg.url) || /octet-stream|mp4/i.test(ct)
            ? await r.arrayBuffer()
            : await r.text();

        if (typeof payload === "string" && payload.trim().startsWith("#EXTM3U")) {
          const stitched = await stitchHlsManifestInPage(payload, msg.url, fetchFn);
          return postToBridge({ type: "CMD_RESPONSE", reqId: msg.reqId, ...stitched });
        }

        const parsed = Parser.parseUniversalSubtitle(payload, msg.url);
        return postToBridge({
          type: "CMD_RESPONSE",
          reqId: msg.reqId,
          ok: parsed.cues.length > 0,
          format: parsed.format,
          cues: parsed.cues
        });
      } catch (e) {
        return postToBridge({ type: "CMD_RESPONSE", reqId: msg.reqId, ok: false, error: e.message });
      }
    }

    if (msg.cmd === "STITCH_HLS_SEGMENTS") {
      try {
        const result = await Parser.stitchHlsSegments(msg.segments || [], fetchFn, "include");
        return postToBridge({ type: "CMD_RESPONSE", reqId: msg.reqId, ...result });
      } catch (e) {
        return postToBridge({ type: "CMD_RESPONSE", reqId: msg.reqId, ok: false, error: e.message });
      }
    }
  });
})();
