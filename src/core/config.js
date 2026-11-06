// @ts-check
/**
 * Shared Configuration, Constants, JSDoc Type Definitions & Path Utilities.
 * Works in Service Worker (self), Content Scripts (window), and Node.js (globalThis).
 */

(function (root) {
  /**
   * @typedef {"md" | "txt" | "srt" | "vtt"} ExportFormat
   * @typedef {"dark" | "light"} ThemeMode
   * @typedef {"title" | "prefix"} NamingMode
   *
   * @typedef {Object} UserSettings
   * @property {ThemeMode} theme
   * @property {ExportFormat} exportFormat
   * @property {string} downloadFolder
   * @property {boolean} saveAs
   * @property {NamingMode} namingMode
   * @property {boolean} includeTimestamps
   * @property {boolean} includeHeader
   * @property {boolean} stripSoundTags
   * @property {boolean} saveReport
   * @property {boolean} showHud
   * @property {string} prefLang
   *
   * @typedef {Object} SubtitleCue
   * @property {number} startSec
   * @property {number} endSec
   * @property {string} ts
   * @property {string} text
   *
   * @typedef {Object} CapturedTrack
   * @property {string} key
   * @property {string} url
   * @property {string} label
   * @property {string} lang
   * @property {string} format
   * @property {boolean} isHlsPlaylist
   * @property {string[]} [segments]
   * @property {SubtitleCue[]} cues
   * @property {number} [t]
   *
   * @typedef {Object} LanguageOption
   * @property {string} code
   * @property {string} [baseCode]
   * @property {string} label
   * @property {boolean} isAuto
   *
   * @typedef {Object} PlaylistVideoItem
   * @property {number} pos
   * @property {string} id
   * @property {string} title
   */

  /** @type {Readonly<UserSettings>} */
  const DEFAULT_SETTINGS = Object.freeze({
    theme: "dark",
    exportFormat: "md",
    downloadFolder: "Subtitles",
    saveAs: false,
    namingMode: "title",
    includeTimestamps: true,
    includeHeader: true,
    stripSoundTags: false,
    saveReport: true,
    showHud: true,
    prefLang: "en"
  });

  const STORAGE_KEYS = Object.freeze({
    SETTINGS: "settings_v5",
    SEASON_LEDGERS: "ledgers_v5",
    PLAYLIST_LEDGERS: "yt_ledgers_v5",
    SEASON_PREFIX: "prefix",
    PLAYLIST_PREFIX: "plPrefix",
    SEASON_NAMING_MODE: "seasonNamingMode"
  });

  const LIMITS = Object.freeze({
    MAX_TRACKS_PER_TAB: 35,
    MAX_CUES_PER_TRACK: 20000,
    MAX_HLS_SEGMENTS: 400,
    HLS_BATCH_SIZE: 16,
    MAX_FETCH_BYTES: 5 * 1024 * 1024,
    MAX_FMP4_BYTES: 4 * 1024 * 1024
  });

  // Pre-compiled regular expressions for hot network & URL paths
  const RE_SAFE_CHARS = /[^A-Za-z0-9_\-]+/g;
  const RE_TRIM_UNDERSCORE = /^_+|_+$/g;
  const RE_ILLEGAL_PATH = /[\\/:*?"<>|\x00-\x1f\x7f-\x9f]+/g;
  const RE_INVISIBLE_FORMAT_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]+/g;
  const RE_MULTI_SPACE = /\s+/g;
  const RE_TRIM_DOTS = /^[.\s]+|[.\s]+$/g;
  const RE_NOTIF_COUNT = /^\(\d+\)\s*/;
  const RE_TITLE_SUFFIX = /\s*[-|–—]\s*[^-|–—]+$/;
  const RE_SEG_CHUNK =
    /([/_-](?:seg|segment|chunk|frag|part|sub|piece)[_-]?)?\d+(\.(?:vtt|webvtt|srt|ttml|dfxp|xml|m4s|mp4|dash|cmft))$/i;
  const RE_SEG_NUM = /\/\d+\.(vtt|webvtt|m4s|ttml|dfxp)$/i;
  const RE_SUB_EXT = /\.(vtt|webvtt|srt|ttml|dfxp|xml|ass|ssa|smi|sami|m3u8|json3|srv3)$/i;
  const RE_PATH_LANG =
    /\/([a-z]{2}(?:-[A-Z]{2})?|eng|hin|spa|fra|deu|jpn|kor|por|ita|rus|ara|tam|tel|mal|kan|ben|mar)(?:[/_.-]|$)/i;
  const RE_NON_SUB_EXT = /\.(ts|m4a|aac|mp3|ogg|wav|jpg|jpeg|png|gif|webp|svg|woff2?|ttf|css|js)(\?|$)/i;
  const RE_NON_SUB_MIME = /^(video|audio|image|font)\//i;
  const RE_SUB_MIME = /text\/vtt|application\/x-subrip|application\/ttml\+xml|application\/ttaf\+xml/i;
  const RE_DIRECT_SUB_EXT = /\.(vtt|webvtt|srt|ttml|dfxp|ass|ssa|smi|sami|srv1|srv2|srv3|json3)(\?|$|#)/i;
  const RE_SUB_PATH_HINT = /\/(timedtext|subtitles?|captions?|texttracks?|closedcaptions?|cc_load)\b/i;
  const RE_SUB_QUERY_FMT = /[?&](format|fmt)=(webvtt|vtt|srt|srv1|srv2|srv3|json3|ttml|dfxp)\b/i;
  const RE_M3U8_EXT = /\.m3u8(\?|$)/i;
  const RE_OTT_CDN =
    /nflxvideo\.net|pv-cdn\.net|atv-ps|dssott\.com|bamgrid\.com|hotstar|zee5|sonyliv|viki\.io|crunchyroll|tiktokcdn|vimeocdn|dmcdn|twimg\.com/i;
  const RE_FMP4_EXT = /\.(m4s|mp4|dash|cmft)(\?|$)/i;
  const RE_SUB_WORD = /(sub|text|caption|ttml|wvtt|stpp|vtt|cc)/i;

  /**
   * Promise-based delay helper.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Inclusive integer range generator [start..end].
   * @param {number} start
   * @param {number} end
   * @returns {number[]}
   */
  const range = (start, end) =>
    Array.from({ length: Math.max(0, end - start + 1) }, (_, idx) => start + idx);

  /**
   * Sanitize string into an underscore-separated identifier for prefix mode.
   * @param {string | null | undefined} input
   * @param {string} [fallback="Subtitles"]
   * @returns {string}
   */
  function safeName(input, fallback = "Subtitles") {
    return (
      String(input || "")
        .trim()
        .replace(RE_SAFE_CHARS, "_")
        .replace(RE_TRIM_UNDERSCORE, "")
        .slice(0, 80) || fallback
    );
  }

  /**
   * Preserve exact readable title while stripping OS-illegal path characters.
   * @param {string | null | undefined} input
   * @param {string} [fallback="Transcript"]
   * @returns {string}
   */
  function exactFileName(input, fallback = "Transcript") {
    return (
      String(input || "")
        .replace(RE_INVISIBLE_FORMAT_CHARS, "")
        .replace(RE_ILLEGAL_PATH, " - ")
        .replace(RE_MULTI_SPACE, " ")
        .replace(RE_TRIM_DOTS, "")
        .trim()
        .slice(0, 110)
        .replace(RE_TRIM_DOTS, "") || fallback
    );
  }

  /**
   * Strip notification counters and site suffixes from a document title.
   * @param {string | null | undefined} rawTitle
   * @param {string} [fallback="Current Video"]
   * @returns {string}
   */
  function cleanPageTitle(rawTitle, fallback = "Current Video") {
    const cleaned = String(rawTitle || "")
      .replace(RE_NOTIF_COUNT, "")
      .replace(RE_TITLE_SUFFIX, "")
      .trim();
    return cleaned || String(rawTitle || "").trim() || fallback;
  }

  /**
   * Extract clean series/show title by stripping marketing prefixes, suffixes, and season markers.
   * Keeps natural spaces without hardcoding proprietary names.
   * @param {string | null | undefined} rawTitle
   * @param {string} [fallback="Series"]
   * @returns {string}
   */
  function cleanShowTitle(rawTitle, fallback = "Series") {
    let t = cleanPageTitle(rawTitle, fallback);
    t = t.split(/[-|–—•]/)[0].trim();
    t = t.replace(/^(?:watch|stream|view|play)\s+/i, "");
    t = t.replace(
      /\s+(?:all\s+episodes?|full\s+episodes?|episodes?|online|free|hd|web\s+series|tv\s+series)\b.*$/i,
      ""
    );
    t = t.replace(/\s+(?:season|s)\s*\d+.*$/i, "");
    t = exactFileName(t, fallback).trim();
    return t || fallback;
  }

  /**
   * Build relative download path inside the browser's Downloads folder.
   * @param {string} subPath
   * @param {string} [downloadFolder="Subtitles"]
   * @returns {string}
   */
  function buildDownloadPath(subPath, downloadFolder = "Subtitles") {
    const cleanBase = String(downloadFolder ?? "Subtitles")
      .split("/")
      .map((part) => exactFileName(part, ""))
      .filter(Boolean)
      .join("/");
    return cleanBase ? `${cleanBase}/${subPath}` : subPath;
  }

  /**
   * Canonicalize segmented subtitle URLs so numbered chunks (seg-01.vtt, seg-02.vtt)
   * map to a single logical subtitle track key.
   * @param {string} rawUrl
   * @param {string} [baseHref]
   * @returns {string}
   */
  function canonicalizeTrackUrl(rawUrl, baseHref) {
    try {
      const u = baseHref ? new URL(rawUrl, baseHref) : new URL(rawUrl);
      const langParam =
        u.searchParams.get("lang") ||
        u.searchParams.get("tlang") ||
        u.searchParams.get("language") ||
        u.searchParams.get("hl") ||
        "";
      const normPath = u.pathname.replace(RE_SEG_CHUNK, "$1*$2").replace(RE_SEG_NUM, "/*.$1");
      if (normPath !== u.pathname) {
        return `${u.origin}${normPath}${langParam ? "?lang=" + langParam : ""}`;
      }
      return rawUrl;
    } catch (_) {
      return rawUrl;
    }
  }

  /**
   * Infer language code, format badge, and display label from a track URL.
   * @param {string} url
   * @param {string} [formatHint=""]
   * @param {string} [baseHref]
   * @returns {{ lang: string, format: string, label: string }}
   */
  function inferTrackMetadata(url, formatHint = "", baseHref) {
    try {
      const u = baseHref ? new URL(url, baseHref) : new URL(url);
      const langParam =
        u.searchParams.get("lang") ||
        u.searchParams.get("tlang") ||
        u.searchParams.get("language") ||
        u.searchParams.get("locale") ||
        "";
      const parts = u.pathname.split("/").filter(Boolean);
      const lastSegment = parts[parts.length - 1] || "Subtitle Track";
      const extMatch = lastSegment.match(RE_SUB_EXT);
      const format =
        formatHint ||
        (extMatch ? extMatch[1].toUpperCase().replace("WEBVTT", "VTT") : "SUB");
      const pathLangMatch = u.pathname.match(RE_PATH_LANG);
      const lang = langParam || (pathLangMatch ? pathLangMatch[1] : "");
      const label = lang
        ? `${lang.toUpperCase()} · ${lastSegment.slice(0, 34)}`
        : lastSegment.slice(0, 40);
      return { lang, format, label };
    } catch (_) {
      return { lang: "", format: formatHint || "SUB", label: "Subtitle Track" };
    }
  }

  /**
   * Fast pre-filter to determine whether a network request/response is likely a subtitle asset.
   * @param {string} url
   * @param {string} [contentType=""]
   * @returns {boolean}
   */
  function isLikelySubtitleRequest(url, contentType = "") {
    const rawU = String(url || "");
    if (!rawU || rawU.startsWith("data:image")) return false;
    let u = rawU;
    try {
      u = decodeURIComponent(rawU);
    } catch (_) {}
    const ct = String(contentType || "").toLowerCase();

    if (RE_NON_SUB_EXT.test(u.split("?")[0]) || RE_NON_SUB_MIME.test(ct)) {
      return false;
    }
    if (
      RE_SUB_MIME.test(ct) ||
      ct.includes("text/srt") ||
      RE_DIRECT_SUB_EXT.test(u) ||
      /\.(vtt|webvtt|srt|ttml|dfxp|ass|ssa)\b/i.test(u) ||
      RE_SUB_PATH_HINT.test(u) ||
      /\b(wyzie|opensubtitles|subdl|subsource)\b/i.test(u) ||
      RE_SUB_QUERY_FMT.test(u) ||
      RE_M3U8_EXT.test(u) ||
      ct.includes("mpegurl")
    ) {
      return true;
    }
    if (RE_OTT_CDN.test(u)) {
      if (/xml|text\/plain|octet-stream|json/i.test(ct) || /\.(xml|m4s|mp4|dash|cmft)(\?|$)/i.test(u)) {
        return true;
      }
    }
    if (RE_FMP4_EXT.test(u) && RE_SUB_WORD.test(u)) {
      return true;
    }
    return false;
  }

  root.SubConfig = Object.freeze({
    DEFAULT_SETTINGS,
    STORAGE_KEYS,
    LIMITS,
    sleep,
    range,
    safeName,
    exactFileName,
    cleanPageTitle,
    cleanShowTitle,
    buildDownloadPath,
    canonicalizeTrackUrl,
    inferTrackMetadata,
    isLikelySubtitleRequest
  });
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
