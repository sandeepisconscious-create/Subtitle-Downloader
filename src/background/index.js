// @ts-check
/**
 * Subtitle Downloader - Background Service Worker Entrypoint.
 * Coordinates state persistence, message routing, tab lifecycle, and download pipelines.
 */

importScripts(
  "../core/config.js",
  "../core/subtitle_parser.js",
  "./hud.js",
  "./track_registry.js",
  "./playlist_pipeline.js",
  "./season_pipeline.js"
);

const Config = self.SubConfig;
const Hud = self.SubHud;
const Registry = self.SubTrackRegistry;
const PlaylistPipeline = self.SubPlaylistPipeline;
const SeasonPipeline = self.SubSeasonPipeline;

const LANG_DISPLAY_NAMES =
  typeof Intl !== "undefined" && Intl.DisplayNames
    ? new Intl.DisplayNames(["en"], { type: "language" })
    : null;

function resolveAvailableLangs(tabId) {
  const out = [...(S.plAvailableLangs || [])];
  const seen = new Set(out.map((l) => l.code));
  for (const tr of Registry.getTabTracks(tabId)) {
    const code = (tr.lang || "").trim();
    if (!code || code === "und" || code === "live" || seen.has(code)) continue;
    seen.add(code);
    let readable = code.toUpperCase();
    try {
      if (LANG_DISPLAY_NAMES) readable = LANG_DISPLAY_NAMES.of(code) || readable;
    } catch (_) {}
    out.push({ code, label: readable, isAuto: false });
  }
  return out;
}

const S = {
  enabled: false,
  /** @type {"season" | "playlist" | null} */
  mode: null,
  /** @type {number | null} */
  tabId: null,
  status: "Ready.",
  skipRequested: false,
  /** @type {import('../core/config.js').UserSettings} */
  settings: { ...Config.DEFAULT_SETTINGS },
  // Season state
  /** @type {number | null} */
  season: null,
  prefix: "Series",
  /** @type {string | null} */
  listUrl: null,
  /** @type {Record<number, { n: number, title: string, href: string | null }>} */
  map: {},
  /** @type {number | null} */
  mapSeason: null,
  /** @type {Record<string | number, Record<string | number, any>>} */
  ledgers: {},
  // Playlist state
  plPrefix: "Playlist",
  plLangs: ["en", "hi"],
  plStatus: "Ready to download transcripts.",
  /** @type {string | null} */
  plKey: null,
  /** @type {string | null} */
  plTitle: null,
  plIsPlaylist: false,
  /** @type {{ id: string, title: string } | null} */
  plCurrentVideo: null,
  /** @type {Array<{ pos: number, id: string, title: string }>} */
  plVideos: [],
  plRangeStart: 1,
  plRangeEnd: 0,
  /** @type {Array<{ code: string, label: string, isAuto: boolean }>} */
  plAvailableLangs: [],
  /** @type {Record<string, Record<string | number, any>>} */
  plLedgers: {}
};

/** @type { ReturnType<typeof setInterval> | null } */
let keepAlive = null;
/** @type { Promise<void> | null } */
let stateLoaded = null;

function loadStateOnce() {
  if (!stateLoaded) {
    stateLoaded = chrome.storage.local
      .get([
        Config.STORAGE_KEYS.SEASON_LEDGERS,
        Config.STORAGE_KEYS.PLAYLIST_LEDGERS,
        Config.STORAGE_KEYS.SETTINGS
      ])
      .then((d) => {
        const rawLedgers = d[Config.STORAGE_KEYS.SEASON_LEDGERS] || {};
        let hadLegacy = false;
        for (const k of Object.keys(rawLedgers)) {
          if (/^\d+$/.test(k)) {
            delete rawLedgers[k];
            hadLegacy = true;
          }
        }
        S.ledgers = rawLedgers;
        S.plLedgers = d[Config.STORAGE_KEYS.PLAYLIST_LEDGERS] || {};
        S.settings = { ...Config.DEFAULT_SETTINGS, ...(d[Config.STORAGE_KEYS.SETTINGS] || {}) };
        if (hadLegacy) {
          chrome.storage.local.set({ [Config.STORAGE_KEYS.SEASON_LEDGERS]: S.ledgers });
        }
      });
  }
  return stateLoaded;
}

const saveState = () =>
  chrome.storage.local.set({
    [Config.STORAGE_KEYS.SEASON_LEDGERS]: S.ledgers,
    [Config.STORAGE_KEYS.PLAYLIST_LEDGERS]: S.plLedgers
  });

const getLedgerKey = (season, showTitle) => {
  const show = Config.safeName(showTitle || S.prefix || "show", "show");
  const s = parseInt(season || S.season || 1, 10) || 1;
  return `${show}_s${s}`;
};
const ledgerFor = (season, showTitle) => {
  const k = getLedgerKey(season, showTitle);
  return (S.ledgers[k] = S.ledgers[k] || {});
};
const plLedgerFor = (key) => (S.plLedgers[key] = S.plLedgers[key] || {});

function buildStatus(season, showTitle) {
  const sn = season || S.season;
  const led = sn ? ledgerFor(sn, showTitle) : {};
  const done = Object.keys(led)
    .filter((k) => led[k].ok)
    .map(Number)
    .sort((a, b) => a - b);
  const hasMap = S.mapSeason == sn && Object.keys(S.map).length > 0;
  const targets = hasMap
    ? Object.keys(S.map)
        .map(Number)
        .sort((a, b) => a - b)
    : [];
  return {
    enabled: S.enabled,
    mode: S.mode,
    tabId: S.tabId,
    statusMessage: S.status,
    season: sn,
    done,
    total: hasMap ? targets.length : null,
    missing: hasMap ? targets.filter((n) => !done.includes(n)) : []
  };
}

function buildPlaylistStatus() {
  const key = S.plKey;
  const led = key ? plLedgerFor(key) : {};
  const done = Object.keys(led)
    .filter((k) => led[k].ok)
    .map(Number)
    .sort((a, b) => a - b);
  const targets = S.plVideos.map((v) => v.pos).sort((a, b) => a - b);
  return {
    enabled: S.enabled,
    mode: S.mode,
    tabId: S.tabId,
    statusMessage: S.plStatus,
    playlistKey: key,
    playlistTitle: S.plTitle,
    isPlaylist: S.plIsPlaylist,
    currentVideo: S.plCurrentVideo || null,
    availableLangs: S.plAvailableLangs || [],
    done,
    total: targets.length || null,
    missing: targets.filter((n) => !done.includes(n))
  };
}

const KEEPALIVE_ALARM = "sub_downloader_keepalive";

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === KEEPALIVE_ALARM) {
      if (S.enabled) {
        chrome.runtime.getPlatformInfo(() => Hud.ignoreErr());
      } else {
        chrome.alarms.clear(KEEPALIVE_ALARM);
      }
    }
  });
}

function startKeepAlive() {
  stopKeepAlive();
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => Hud.ignoreErr()), 20000);
  if (chrome.alarms) {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  }
}

function stopKeepAlive() {
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
  if (chrome.alarms) {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  }
}

function setStatus(msg) {
  S.status = msg;
  if (S.tabId != null && S.settings.showHud !== false) {
    const st = buildStatus();
    Hud.showHud(S.tabId, msg, st.done.length, st.total, S.enabled, S.settings.showHud !== false);
  }
}

function setPlStatus(msg) {
  S.plStatus = msg;
  if (S.tabId != null && S.settings.showHud !== false) {
    const st = buildPlaylistStatus();
    Hud.showHud(S.tabId, msg, st.done.length, st.total, S.enabled, S.settings.showHud !== false);
  }
}

function stopRun(msg) {
  const prevMode = S.mode;
  S.enabled = false;
  S.mode = null;
  stopKeepAlive();
  if (msg) {
    if (prevMode === "playlist") setPlStatus(msg);
    else setStatus(msg);
  }
}

const pipelineHelpers = Object.freeze({
  ledgerFor,
  plLedgerFor,
  saveState,
  setStatus,
  setPlStatus,
  stopRun
});

// Register WebRequest Listeners
Registry.registerWebRequestListeners();

chrome.tabs.onRemoved.addListener((tabId) => {
  Registry.clearTabTracks(tabId);
  if (S.tabId === tabId) stopRun("Stopped (tab closed).");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    Registry.clearTabTracks(tabId);
  }
});

// Message Router
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  (async () => {
    await loadStateOnce();
    switch (req.action) {
      case "reportInPageTrack": {
        const tabId = sender && sender.tab ? sender.tab.id : req.tabId;
        if (typeof tabId === "number" && req.track) {
          Registry.upsertCapturedTrack(tabId, req.track);
        }
        sendResponse({ ok: true });
        break;
      }
      case "updateSettings":
        S.settings = { ...Config.DEFAULT_SETTINGS, ...(req.settings || {}) };
        if (S.settings.showHud === false && req.tabId) {
          Hud.removeHud(req.tabId);
        }
        sendResponse({ ok: true });
        break;
      case "getCaptured": {
        if (req.scanNow && req.tabId) {
          await Registry.ensureTabScriptsAndScan(req.tabId);
          const initial = Registry.getTabTracks(req.tabId);
          if (!initial.some((t) => Array.isArray(t.cues) && t.cues.length > 0)) {
            await SeasonPipeline.ensureSubtitlesEnabled(req.tabId, S.settings && S.settings.prefLang);
            await Config.sleep(900);
            await Registry.ensureTabScriptsAndScan(req.tabId);
          }
        }
        const rawList = Registry.getTabTracks(req.tabId);
        const sorted = [...rawList].sort((a, b) => {
          const ac = (a.cues && a.cues.length) || 0;
          const bc = (b.cues && b.cues.length) || 0;
          if (bc !== ac) return bc - ac;
          if (b.isHlsPlaylist !== a.isHlsPlaylist) return b.isHlsPlaylist ? 1 : -1;
          return (b.t || 0) - (a.t || 0);
        });
        sendResponse({
          langs: resolveAvailableLangs(req.tabId),
          items: sorted.map((c) => ({
            key: c.key,
            url: c.url,
            label: c.label,
            lang: c.lang,
            format: c.format,
            isHlsPlaylist: !!c.isHlsPlaylist,
            cueCount: (c.cues && c.cues.length) || 0,
            segmentCount: (c.segments && c.segments.length) || 0
          }))
        });
        break;
      }
      case "saveGeneric":
        sendResponse(
          await Registry.saveGeneric(req.tabId, req.url || req.key, req.prefix, S.settings, !!req.copyOnly)
        );
        break;
      case "getAvailableLanguages": {
        const out = resolveAvailableLangs(req.tabId);
        sendResponse({ langs: out, languages: out });
        break;
      }

      // --- Season actions ---
      case "detectSeason":
        sendResponse({ season: await SeasonPipeline.detectActiveSeason(req.tabId) });
        break;
      case "scanEpisodeList": {
        S.tabId = req.tabId;
        if (req.showTitle) S.prefix = req.showTitle;
        const info = await SeasonPipeline.buildEpisodeMap(req.tabId, setStatus, S);
        if (info.ok && info.map && Object.keys(info.map).length > 0) {
          S.map = info.map;
          S.mapSeason = req.season;
          setStatus(`Season ${req.season || 1}: ${info.count} episodes ready.`);
        }
        sendResponse({ info, diag: info.diag });
        break;
      }
      case "startAutoPilot":
        if (S.enabled) return sendResponse({ status: "already running" });
        S.enabled = true;
        S.mode = "season";
        S.tabId = req.tabId;
        S.season = parseInt(req.season, 10);
        S.prefix = Config.exactFileName(req.prefix, "Series");
        S.seasonNamingMode = req.seasonNamingMode || "numbered";
        sendResponse({ status: "started" });
        startKeepAlive();
        SeasonPipeline.runSeasonPipeline(req.tabId, S.season, S, pipelineHelpers).catch((e) =>
          stopRun(`Unexpected error: ${e.message}`)
        );
        break;
      case "stopAutoPilot":
        stopRun("Stopped by user.");
        sendResponse({ status: "stopped" });
        break;
      case "skipCurrentEpisode":
        if (S.enabled) {
          S.skipRequested = true;
          setStatus("Skipping current episode...");
          sendResponse({ ok: true, status: "skipping" });
        } else {
          sendResponse({ ok: false, reason: "not-running" });
        }
        break;
      case "resetLedger":
        delete S.ledgers[req.season];
        delete S.ledgers[getLedgerKey(req.season, req.showTitle)];
        await saveState();
        sendResponse({ status: "reset" });
        break;
      case "getAutoPilotStatus":
        sendResponse(buildStatus(req.season, req.showTitle));
        break;

      // --- Playlist / Video actions ---
      case "scanPlaylistPage": {
        const info = await PlaylistPipeline.scanPlaylistPage(req.tabId, S, setPlStatus, req.quiet);
        sendResponse({ info });
        break;
      }
      case "getPlaylistStatus":
        sendResponse(buildPlaylistStatus());
        break;
      case "startPlaylist":
        if (S.enabled) return sendResponse({ status: "already running" });
        S.enabled = true;
        S.mode = "playlist";
        S.tabId = req.tabId;
        S.plPrefix = Config.safeName(req.prefix || S.plTitle, "Playlist");
        S.plRangeStart = Math.max(1, parseInt(req.rangeStart, 10) || 1);
        S.plRangeEnd = Math.max(0, parseInt(req.rangeEnd, 10) || 0);
        S.plLangs = String(req.lang || S.settings.prefLang || "en,hi")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        if (!S.plLangs.length) S.plLangs = ["en", "hi"];
        sendResponse({ status: "started" });
        startKeepAlive();
        PlaylistPipeline.runPlaylistPipeline(req.tabId, S, pipelineHelpers).catch((e) =>
          stopRun(`Unexpected error: ${e.message}`)
        );
        break;
      case "resetPlaylistLedger":
        if (S.plKey) {
          delete S.plLedgers[S.plKey];
          await saveState();
        }
        sendResponse({ status: "reset" });
        break;
      case "downloadSingleVideo": {
        const langs = String(req.lang || S.settings.prefLang || "en,hi")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        const r = await PlaylistPipeline.downloadSingleVideo(
          req.tabId,
          req.prefix,
          langs.length ? langs : ["en", "hi"],
          S,
          setPlStatus,
          !!req.copyOnly
        );
        sendResponse(r);
        break;
      }
    }
  })();
  return true;
});
