// @ts-check
/**
 * Universal Subtitle Track Registry, WebRequest Listeners, Cue Resolver & Generic Saver.
 */

(function (root) {
  const Config = root.SubConfig;
  const Parser = root.UniversalSubtitleParser;
  const Hud = root.SubHud;

  /** @type {Record<number, Array<import('../core/config.js').CapturedTrack>>} */
  const captures = {};
  /** @type {Record<number, number>} */
  const playlistVideoCountByTab = {};

  function getTabTracks(tabId) {
    return captures[tabId] || [];
  }

  function setTabVideoCount(tabId, count) {
    if (typeof tabId !== "number" || tabId < 0) return;
    if (count && count > 0) {
      playlistVideoCountByTab[tabId] = count;
      Hud.setTabBadge(tabId, String(count));
    } else {
      delete playlistVideoCountByTab[tabId];
      Hud.setTabBadge(tabId, captures[tabId]?.length ? "1" : "");
    }
  }

  function clearTabTracks(tabId) {
    delete captures[tabId];
    delete playlistVideoCountByTab[tabId];
    Hud.setTabBadge(tabId, "");
  }

  function resetTabTracksForEpisode(tabId) {
    captures[tabId] = [];
    delete playlistVideoCountByTab[tabId];
    Hud.setTabBadge(tabId, "");
  }

  /**
   * Insert or merge a captured subtitle track into the tab's registry.
   * @param {number} tabId
   * @param {Partial<import('../core/config.js').CapturedTrack>} trackIn
   */
  function upsertCapturedTrack(tabId, trackIn) {
    if (typeof tabId !== "number" || tabId < 0 || !trackIn) return;
    captures[tabId] = captures[tabId] || [];
    const key = trackIn.key || Config.canonicalizeTrackUrl(trackIn.url || "");
    if (!key) return;

    let existing = captures[tabId].find((c) => c.key === key || (trackIn.url && c.url === trackIn.url));
    if (!existing) {
      if (captures[tabId].length >= Config.LIMITS.MAX_TRACKS_PER_TAB) {
        captures[tabId].shift();
      }
      const meta = Config.inferTrackMetadata(trackIn.url || key, trackIn.format);
      existing = {
        key,
        url: trackIn.url || key,
        label: trackIn.label || meta.label,
        lang: trackIn.lang || meta.lang,
        format: trackIn.format || meta.format,
        isHlsPlaylist: !!trackIn.isHlsPlaylist,
        segments: Array.isArray(trackIn.segments) ? trackIn.segments : [],
        cues: Array.isArray(trackIn.cues) ? Parser.normalizeAndDedupeCues(trackIn.cues) : [],
        t: Date.now()
      };
      captures[tabId].push(existing);
    } else {
      if (trackIn.url && !trackIn.url.startsWith("texttrack://")) existing.url = trackIn.url;
      if (trackIn.label && (!existing.label || existing.label === "Subtitle Track")) existing.label = trackIn.label;
      if (trackIn.lang && !existing.lang) existing.lang = trackIn.lang;
      if (trackIn.format && existing.format === "SUB") existing.format = trackIn.format;
      if (trackIn.isHlsPlaylist) existing.isHlsPlaylist = true;
      if (Array.isArray(trackIn.segments) && trackIn.segments.length > (existing.segments?.length || 0)) {
        existing.segments = trackIn.segments;
      }
      if (Array.isArray(trackIn.cues) && trackIn.cues.length > 0) {
        existing.cues = Parser.normalizeAndDedupeCues([...(existing.cues || []), ...trackIn.cues]);
      }
      existing.t = Date.now();
    }

    const videoCount = playlistVideoCountByTab[tabId] || (captures[tabId].length > 0 ? 1 : 0);
    Hud.setTabBadge(tabId, videoCount > 0 ? String(videoCount) : "");
  }

  /**
   * Register chrome.webRequest listeners to detect subtitle URLs and Content-Type headers.
   */
  function registerWebRequestListeners() {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        const { url, tabId, type } = details;
        if (typeof tabId !== "number" || tabId < 0) return;
        if (type === "image" || type === "stylesheet" || type === "font" || type === "script") return;
        if (/\.(ts|m4a|aac|mp3|jpg|png|webp|gif|woff2?|css|js)(\?|$)/i.test(url)) return;

        const isDirectSub =
          /\.(vtt|webvtt|srt|ttml|dfxp|ass|ssa|smi|sami|srv1|srv2|srv3|json3)(\?|$|#)/i.test(url) ||
          /\/(subtitles?|captions?|timedtext|texttracks?|closedcaptions?)\b/i.test(url) ||
          /[?&](format|fmt)=(webvtt|vtt|srt|srv3|json3|ttml|dfxp)\b/i.test(url);

        const isSubM3u8 = /\.m3u8(\?|$)/i.test(url) && /(sub|cap|vtt|text|cc|wvtt|stpp)/i.test(url);

        if (isDirectSub || isSubM3u8) {
          const meta = Config.inferTrackMetadata(url, isSubM3u8 ? "HLS" : "");
          upsertCapturedTrack(tabId, {
            key: Config.canonicalizeTrackUrl(url),
            url,
            label: meta.label,
            lang: meta.lang,
            format: isSubM3u8 ? "HLS" : meta.format,
            isHlsPlaylist: isSubM3u8
          });
        }
      },
      { urls: ["<all_urls>"] }
    );

    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        const { url, tabId, responseHeaders } = details;
        if (typeof tabId !== "number" || tabId < 0 || !Array.isArray(responseHeaders)) return;
        const ctHeader = responseHeaders.find((h) => h.name && h.name.toLowerCase() === "content-type");
        if (!ctHeader || !ctHeader.value) return;
        const ct = ctHeader.value.toLowerCase();

        if (/text\/vtt|application\/x-subrip|application\/ttml\+xml|application\/ttaf\+xml/i.test(ct)) {
          const fmt = ct.includes("vtt") ? "VTT" : ct.includes("subrip") ? "SRT" : "TTML";
          const meta = Config.inferTrackMetadata(url, fmt);
          upsertCapturedTrack(tabId, {
            key: Config.canonicalizeTrackUrl(url),
            url,
            label: meta.label,
            lang: meta.lang,
            format: fmt
          });
        }
      },
      { urls: ["<all_urls>"] },
      ["responseHeaders"]
    );
  }

  /**
   * Ensure content scripts are injected into already-open tabs and trigger an immediate scan.
   * Fast-paths tabs where the bridge is already active to avoid redundant executeScript calls.
   * @param {number} tabId
   */
  async function ensureTabScriptsAndScan(tabId) {
    const fastPing = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 160);
      try {
        chrome.tabs.sendMessage(tabId, { bridgeCmd: "SCAN_NOW", timeoutMs: 140 }, (res) => {
          void chrome.runtime.lastError;
          clearTimeout(timer);
          resolve(res);
        });
      } catch (_) {
        clearTimeout(timer);
        resolve(null);
      }
    });

    if (fastPing && fastPing.ok) return;

    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["src/core/config.js", "src/core/subtitle_parser.js", "src/content/interceptor.js"],
        world: "MAIN"
      });
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["src/content/bridge.js"],
        world: "ISOLATED"
      });
    } catch (_) {}

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 300);
      try {
        chrome.tabs.sendMessage(tabId, { bridgeCmd: "SCAN_NOW", timeoutMs: 250 }, () => {
          void chrome.runtime.lastError;
          clearTimeout(timer);
          resolve(undefined);
        });
      } catch (_) {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  }

  /**
   * Resolve the complete cue list for a captured track (handling in-page fetches and HLS stitching).
   * @param {number} tabId
   * @param {Partial<import('../core/config.js').CapturedTrack>} track
   * @returns {Promise<import('../core/config.js').SubtitleCue[]>}
   */
  async function resolveTrackCues(tabId, track) {
    if (!track) return [];

    // 1. HLS Subtitle Playlist
    if (track.isHlsPlaylist) {
      if (track.segments && track.segments.length > 0) {
        const inPage = await new Promise((resolve) => {
          chrome.tabs.sendMessage(
            tabId,
            { bridgeCmd: "STITCH_HLS_SEGMENTS", segments: track.segments, timeoutMs: 60000 },
            (res) => {
              void chrome.runtime.lastError;
              resolve(res);
            }
          );
        });
        if (inPage && inPage.ok && Array.isArray(inPage.cues) && inPage.cues.length > 0) {
          return inPage.cues;
        }
        const bgStitched = await Parser.stitchHlsSegments(track.segments, fetch, "omit");
        return bgStitched.cues;
      }

      if (track.url && /^https?:/i.test(track.url)) {
        const inPage = await new Promise((resolve) => {
          chrome.tabs.sendMessage(
            tabId,
            { bridgeCmd: "FETCH_AND_PARSE_URL", url: track.url, timeoutMs: 60000 },
            (res) => {
              void chrome.runtime.lastError;
              resolve(res);
            }
          );
        });
        if (inPage && inPage.ok && Array.isArray(inPage.cues) && inPage.cues.length > 0) {
          return inPage.cues;
        }
      }
    }

    // 2. Standard HTTP(S) track URL when pre-captured cues are absent or partial
    if (track.url && /^https?:/i.test(track.url) && (!track.cues || track.cues.length < 25)) {
      const inPage = await new Promise((resolve) => {
        chrome.tabs.sendMessage(
          tabId,
          { bridgeCmd: "FETCH_AND_PARSE_URL", url: track.url, timeoutMs: 30000 },
          (res) => {
            void chrome.runtime.lastError;
            resolve(res);
          }
        );
      });
      if (inPage && inPage.ok && Array.isArray(inPage.cues) && inPage.cues.length > (track.cues?.length || 0)) {
        track.cues = Parser.normalizeAndDedupeCues([...(track.cues || []), ...inPage.cues]);
        return track.cues;
      }

      try {
        const r = await fetch(track.url);
        if (r.ok) {
          const txt = await r.text();
          if (txt.trim().startsWith("#EXTM3U")) {
            const m3u8 = Parser.inspectM3u8Manifest(txt, track.url);
            if (m3u8 && m3u8.type === "media" && m3u8.segments.length) {
              const stitched = await Parser.stitchHlsSegments(m3u8.segments, fetch, "omit");
              if (stitched.cues.length > 0) return stitched.cues;
            }
          } else {
            const parsed = Parser.parseUniversalSubtitle(txt, track.url);
            if (parsed.cues.length > (track.cues?.length || 0)) {
              track.cues = Parser.normalizeAndDedupeCues([...(track.cues || []), ...parsed.cues]);
              return track.cues;
            }
          }
        }
      } catch (_) {}

      // Fallback for YouTube timedtext URLs when the web URL returns 0 bytes (missing PO token)
      if (track.url && /youtube\.com\/api\/timedtext/i.test(track.url) && (!track.cues || !track.cues.length)) {
        try {
          const vidMatch = track.url.match(/[?&]v=([a-zA-Z0-9_-]+)/);
          const langMatch = track.url.match(/[?&]lang=([a-zA-Z0-9_-]+)/);
          if (vidMatch) {
            const fb = await Hud.fetchYoutubeCaptionsViaTab(tabId, vidMatch[1], [langMatch ? langMatch[1] : "en"]);
            if (fb && fb.ok && fb.rawBody) {
              const parsed = Parser.parseUniversalSubtitle(fb.rawBody, fb.hintExt || "timedtext.xml");
              if (parsed && parsed.cues.length > 0) {
                track.cues = parsed.cues;
                return track.cues;
              }
            }
          }
        } catch (_) {}
      }
    }

    return track.cues || [];
  }

  /**
   * Save or copy a specific track (or "__BEST__") from the active tab.
   * @param {number} tabId
   * @param {string} keyOrUrl
   * @param {string} prefixIn
   * @param {import('../core/config.js').UserSettings} settings
   * @param {boolean} [copyOnly=false]
   */
  async function saveGeneric(tabId, keyOrUrl, prefixIn, settings, copyOnly = false) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const prefix = Config.safeName(prefixIn, "Subtitles");
      const rawTitle = Config.cleanPageTitle(tab.title, "Video");
      const slug = Config.safeName(rawTitle, "Video");

      const tabTracks = getTabTracks(tabId);
      let track = null;
      if (keyOrUrl === "__BEST__") {
        const prefLangs = String(settings.prefLang || "en,hi")
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean);
        const scored = [...tabTracks].sort((a, b) => {
          const aLangMatch = prefLangs.some((l) => (a.lang || "").toLowerCase().startsWith(l)) ? 1 : 0;
          const bLangMatch = prefLangs.some((l) => (b.lang || "").toLowerCase().startsWith(l)) ? 1 : 0;
          if (bLangMatch !== aLangMatch) return bLangMatch - aLangMatch;
          return ((b.cues && b.cues.length) || 0) - ((a.cues && a.cues.length) || 0);
        });
        track = scored[0] || null;
      } else {
        track = tabTracks.find((c) => c.key === keyOrUrl || c.url === keyOrUrl) || {
          key: keyOrUrl,
          url: keyOrUrl,
          label: "Subtitle Track",
          lang: "",
          format: "SUB",
          isHlsPlaylist: false,
          cues: []
        };
      }

      if (!track) return { ok: false, error: "No subtitle track available" };

      let cuesList = [];
      for (let i = 0; i < 2 && cuesList.length < 2; i++) {
        cuesList = await resolveTrackCues(tabId, track);
        if (cuesList.length < 2) await Config.sleep(800);
      }
      if (cuesList.length < 1) {
        return { ok: false, error: "Could not read subtitle cues (keep CC enabled while playing)" };
      }

      const ext = (settings.exportFormat || "md").toLowerCase();
      const useExact = settings.namingMode !== "prefix";
      const relPath = useExact
        ? `${Config.exactFileName(rawTitle, "Transcript")}.${ext}`
        : `${prefix}/${prefix}_${slug}_Transcript.${ext}`;
      const filename = Config.buildDownloadPath(relPath, settings.downloadFolder);

      const content = Parser.formatCuesOutput(
        cuesList,
        {
          heading: rawTitle,
          sublines: [
            `**Source:** ${tab.url}`,
            ...(track.lang ? [`**Language:** ${track.lang.toUpperCase()}`] : [])
          ]
        },
        settings
      );

      if (copyOnly) {
        return { ok: true, content, cues: cuesList.length };
      }

      const res = await Hud.downloadVerified(
        Parser.toSubtitleDataUrl(content, ext),
        filename,
        settings.saveAs
      );
      return res.ok ? { ok: true, filename, size: res.size, cues: cuesList.length } : { ok: false, error: res.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  root.SubTrackRegistry = Object.freeze({
    getTabTracks,
    setTabVideoCount,
    clearTabTracks,
    resetTabTracksForEpisode,
    upsertCapturedTrack,
    registerWebRequestListeners,
    ensureTabScriptsAndScan,
    resolveTrackCues,
    saveGeneric
  });
})(self);
