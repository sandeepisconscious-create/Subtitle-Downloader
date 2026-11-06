// @ts-check
/**
 * Playlist & Single Video Caption Pipeline (Supporting Watch Pages, Playlists, Shorts & TV).
 */

(function (root) {
  const Config = root.SubConfig;
  const Parser = root.UniversalSubtitleParser;
  const Hud = root.SubHud;
  const Registry = root.SubTrackRegistry;

  /**
   * Convert raw player captionTracks metadata into sorted, deduplicated LanguageOption items,
   * automatically appending an English auto-translation option when English is not natively present.
   * @param {any[] | null | undefined} tracks
   * @returns {Array<import('../core/config.js').LanguageOption>}
   */
  function mapCaptionTracksToLanguageOptions(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return [];
    const mapped = tracks
      .map((t) => {
        const rawName =
          (t.name &&
            (t.name.simpleText || (Array.isArray(t.name.runs) && t.name.runs.map((r) => r.text).join("")))) ||
          t.languageCode ||
          "Unknown";
        const cleanName = String(rawName).replace(/\s*\(auto-generated\)/i, "").trim();
        const isAuto = t.kind === "asr";
        return {
          code: isAuto ? `${t.languageCode}:asr` : String(t.languageCode || "en"),
          baseCode: String(t.languageCode || "en"),
          label: isAuto ? `${cleanName} (Auto-generated)` : cleanName,
          isAuto
        };
      })
      .sort((a, b) => Number(a.isAuto) - Number(b.isAuto));

    const hasEnglish = mapped.some((l) => /^en\b/i.test(l.baseCode || ""));
    if (!hasEnglish && tracks.some((t) => t.isTranslatable !== false)) {
      mapped.push({
        code: "tlang:en",
        baseCode: "en",
        label: "English (Auto-translated)",
        isAuto: true
      });
    }
    return mapped;
  }

  /**
   * Scan the active tab for a video playlist or single video/Short.
   * @param {number} tabId
   * @param {any} S - Shared service worker state
   * @param {(msg: string) => void} setPlStatus
   * @param {boolean} [quiet=false]
   */
  async function scanPlaylistPage(tabId, S, setPlStatus, quiet = false) {
    if (!quiet) setPlStatus("Scanning page for available subtitles...");
    const res = await Hud.injectMain(tabId, async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const url = new URL(location.href);
      const listId = url.searchParams.get("list");
      const vidParam = url.searchParams.get("v");

      const extractVid = (href) => {
        if (!href) return null;
        const m = href.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/watch\/)([A-Za-z0-9_-]{11})/);
        return m ? m[1] : null;
      };

      const cleanDocTitle = () =>
        (document.title || "")
          .replace(/^\(\d+\)\s*/, "")
          .replace(/\s*[-|–—]\s*[^-|–—]+$/, "")
          .trim();

      const extractInlineTracks = (vid) => {
        try {
          const mp = /** @type {any} */ (document.getElementById("movie_player"));
          const flexy = /** @type {any} */ (document.querySelector("ytd-watch-flexy"));
          const candidates = [
            mp && typeof mp.getPlayerResponse === "function" ? mp.getPlayerResponse() : null,
            flexy && flexy.playerData ? flexy.playerData : null,
            /** @type {any} */ (window).ytInitialPlayerResponse
          ];
          for (const resp of candidates) {
            if (resp && (!vid || !resp.videoDetails?.videoId || resp.videoDetails.videoId === vid)) {
              const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
              if (Array.isArray(tracks) && tracks.length > 0) return tracks;
            }
          }
          return null;
        } catch (_) {
          return null;
        }
      };

      // 1. Playlist Panel on Watch Page
      const panel = document.querySelector("ytd-playlist-panel-renderer#playlist, ytd-playlist-panel-renderer");
      if (panel) {
        const panelItems = [...panel.querySelectorAll("ytd-playlist-panel-video-renderer")];
        if (panelItems.length > 0) {
          const titleEl = /** @type {HTMLElement | null} */ (
            panel.querySelector(".header .title a, .header yt-formatted-string.title, h3 a, .title")
          );
          const playlistTitle =
            (titleEl && titleEl.innerText ? titleEl.innerText.trim().split("\n")[0] : "") || "Playlist";
          const videos = [];
          panelItems.forEach((item) => {
            const a = /** @type {HTMLAnchorElement | null} */ (
              item.querySelector("a#wc-endpoint, a[href*='watch?v=']")
            );
            const id = extractVid(a && a.href);
            if (!id) return;
            const tEl = /** @type {HTMLElement | null} */ (item.querySelector("#video-title"));
            const vTitle = ((tEl && (tEl.innerText || tEl.getAttribute("title"))) || "").trim() || id;
            videos.push({ pos: videos.length + 1, id, title: vTitle });
          });
          if (videos.length > 0) {
            const curItem = vidParam ? videos.find((v) => v.id === vidParam) : null;
            const h1 = /** @type {HTMLElement | null} */ (
              document.querySelector(
                "ytd-watch-metadata h1 yt-formatted-string, #title h1 yt-formatted-string, h1.title"
              )
            );
            const curTitle =
              (curItem && curItem.title) || (h1 && h1.innerText ? h1.innerText.trim() : "") || vidParam;
            return {
              ok: true,
              isPlaylist: true,
              playlistId: listId || playlistTitle,
              playlistTitle,
              currentVideo: vidParam ? { id: vidParam, title: curTitle } : null,
              inlineTracks: extractInlineTracks(vidParam || videos[0].id),
              videos
            };
          }
        }
      }

      // 2. Dedicated Playlist Page (/playlist?list=...)
      if (url.pathname.startsWith("/playlist") || document.querySelector("ytd-playlist-video-list-renderer")) {
        let prevCount = 0;
        for (let i = 0; i < 10; i++) {
          const cont = document.querySelector(
            "ytd-playlist-video-list-renderer ytd-continuation-item-renderer"
          );
          if (!cont) break;
          const curCount = document.querySelectorAll("ytd-playlist-video-renderer").length;
          if (i > 0 && curCount === prevCount) break;
          prevCount = curCount;
          cont.scrollIntoView({ block: "center" });
          await wait(250);
        }
        const rows = [...document.querySelectorAll("ytd-playlist-video-renderer")];
        if (rows.length > 0) {
          const h1 = /** @type {HTMLElement | null} */ (
            document.querySelector(
              "yt-page-header-view-model h1, ytd-playlist-header-renderer #text, h1.style-scope.ytd-playlist-header-renderer"
            )
          );
          const playlistTitle =
            (h1 && h1.innerText ? h1.innerText.trim().split("\n")[0] : "") || cleanDocTitle() || "Playlist";
          const videos = [];
          rows.forEach((row) => {
            const a = /** @type {HTMLAnchorElement | null} */ (
              row.querySelector("a#video-title, a[href*='watch?v=']")
            );
            const id = extractVid(a && a.href);
            if (!id) return;
            const vTitle = ((a && (a.innerText || a.getAttribute("title"))) || "").trim() || id;
            videos.push({ pos: videos.length + 1, id, title: vTitle });
          });
          if (videos.length > 0) {
            return {
              ok: true,
              isPlaylist: true,
              playlistId: listId || playlistTitle,
              playlistTitle,
              currentVideo: null,
              inlineTracks: null,
              videos
            };
          }
        }
      }

      // 3. Single Video / Short / TV Page
      const singleId = vidParam || extractVid(location.href);
      if (singleId) {
        const h1 = /** @type {HTMLElement | null} */ (
          document.querySelector(
            "ytd-watch-metadata h1 yt-formatted-string, #title h1 yt-formatted-string, ytd-reel-video-renderer[is-active] h2, ytd-reel-player-header-renderer h2, h1.title"
          )
        );
        const vTitle = (h1 && h1.innerText ? h1.innerText.trim() : "") || cleanDocTitle() || singleId;
        return {
          ok: true,
          isPlaylist: false,
          playlistId: "video_" + singleId,
          playlistTitle: vTitle,
          currentVideo: { id: singleId, title: vTitle },
          inlineTracks: extractInlineTracks(singleId),
          videos: [{ pos: 1, id: singleId, title: vTitle }]
        };
      }

      return { ok: false, reason: "Open a video or playlist page first." };
    });

    if (!res || !res.ok) {
      return { ok: false, reason: (res && res.reason) || "Could not read video list on this page." };
    }

    S.plKey = Config.safeName(res.playlistId, "Playlist");
    S.plTitle = res.playlistTitle;
    S.plIsPlaylist = res.isPlaylist;
    S.plCurrentVideo = res.currentVideo || null;
    S.plVideos = res.videos;
    Registry.setTabVideoCount(tabId, res.videos.length);

    const inlineLangs = mapCaptionTracksToLanguageOptions(res.inlineTracks);
    if (inlineLangs.length > 0) {
      S.plAvailableLangs = inlineLangs;
    } else {
      const sampleVid = (res.currentVideo && res.currentVideo.id) || (res.videos[0] && res.videos[0].id);
      if (sampleVid) {
        const langs = await fetchVideoLanguageOptions(tabId, sampleVid);
        if (langs && langs.length > 0) {
          S.plAvailableLangs = langs;
        }
      }
    }

    const suggestedPrefix = Config.safeName(
      res.playlistTitle.split(/[-|–—:(]/)[0].trim() || res.playlistTitle,
      "Transcripts"
    ).slice(0, 40);

    return {
      ok: true,
      isPlaylist: res.isPlaylist,
      playlistKey: S.plKey,
      playlistTitle: res.playlistTitle,
      currentVideo: S.plCurrentVideo,
      availableLangs: S.plAvailableLangs || [],
      count: res.videos.length,
      suggestedPrefix
    };
  }

  /**
   * Inspect available caption tracks on a video and return human-readable language options.
   * @param {number} tabId
   * @param {string} videoId
   * @returns {Promise<Array<import('../core/config.js').LanguageOption>>}
   */
  async function fetchVideoLanguageOptions(tabId, videoId) {
    const rawTracks = await Hud.injectMain(
      tabId,
      async (vid) => {
        try {
          let tracks = null;
          try {
            const mp = /** @type {any} */ (document.getElementById("movie_player"));
            const flexy = /** @type {any} */ (document.querySelector("ytd-watch-flexy"));
            const candidates = [
              mp && typeof mp.getPlayerResponse === "function" ? mp.getPlayerResponse() : null,
              flexy && flexy.playerData ? flexy.playerData : null,
              /** @type {any} */ (window).ytInitialPlayerResponse
            ];
            for (const resp of candidates) {
              if (resp && resp.videoDetails && resp.videoDetails.videoId === vid) {
                const pt = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                if (Array.isArray(pt) && pt.length > 0) {
                  tracks = pt;
                  break;
                }
              }
            }
          } catch (_) {}

          if (!tracks || !tracks.length) {
            const playerResp = await fetch("/youtubei/v1/player?prettyPrint=false", {
              method: "POST",
              credentials: "omit",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                context: {
                  client: { clientName: "ANDROID", clientVersion: "20.10.38" }
                },
                videoId: vid
              })
            });
            if (playerResp.ok) {
              const data = await playerResp.json();
              tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            }
          }
          return Array.isArray(tracks) ? tracks : [];
        } catch (_) {
          return [];
        }
      },
      [videoId]
    );

    return mapCaptionTracksToLanguageOptions(rawTracks);
  }

  /**
   * Fetch captions for a single video ID using live player PO-token URLs, in-page player state,
   * and multi-client Innertube player API fallback.
   * @param {number} tabId
   * @param {string} videoId
   * @param {string[]} langs
   */
  async function fetchVideoCaptions(tabId, videoId, langs) {
    const viaTab = await Hud.fetchYoutubeCaptionsViaTab(tabId, videoId, langs);
    if (viaTab && viaTab.ok && viaTab.rawBody) {
      const tabParsed = Parser.parseUniversalSubtitle(viaTab.rawBody, viaTab.hintExt || "timedtext.xml");
      if (tabParsed && tabParsed.cues && tabParsed.cues.length >= 2) {
        return {
          ok: true,
          cues: tabParsed.cues,
          langCode: viaTab.langCode || "en",
          isGenerated: !!viaTab.isGenerated
        };
      }
      return { ok: false, error: `Caption file parsed to ${tabParsed ? tabParsed.cues.length : 0} cues` };
    }

    return { ok: false, error: (viaTab && viaTab.error) || "Could not fetch captions" };
  }

  function getPlaylistFolderName(S) {
    const useExact = S.settings.namingMode !== "prefix";
    return useExact
      ? Config.exactFileName(S.plTitle, "Subtitles")
      : Config.safeName(S.plPrefix || S.plTitle, "Subtitles");
  }

  /**
   * Download or copy captions for the currently active video only.
   */
  async function downloadSingleVideo(tabId, prefixIn, langs, S, setPlStatus, copyOnly = false) {
    if (!S.plCurrentVideo) {
      await scanPlaylistPage(tabId, S, setPlStatus, true);
    }
    const target = S.plCurrentVideo || (S.plVideos && S.plVideos[0]);
    if (!target || !target.id) return { ok: false, error: "No video detected on this page" };

    const cap = await fetchVideoCaptions(tabId, target.id, langs);
    if ((!cap || !cap.ok) && Registry.getTabTracks(tabId).length > 0) {
      const fallbackSave = await Registry.saveGeneric(tabId, "__BEST__", prefixIn, S.settings, copyOnly);
      if (fallbackSave.ok) {
        return {
          ok: true,
          content: fallbackSave.content,
          filename: fallbackSave.filename,
          size: fallbackSave.size,
          lines: fallbackSave.cues
        };
      }
    }
    if (!cap || !cap.ok) return { ok: false, error: (cap && cap.error) || "Could not fetch captions" };

    const ext = (S.settings.exportFormat || "md").toLowerCase();
    const useExact = S.settings.namingMode !== "prefix";
    const prefix = Config.safeName(prefixIn || target.title, "Transcript");
    const relPath = useExact
      ? `${Config.exactFileName(target.title, target.id)}.${ext}`
      : `${prefix}_${Config.safeName(target.title, target.id)}_Transcript.${ext}`;
    const filename = Config.buildDownloadPath(relPath, S.settings.downloadFolder);

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const origin = tab && tab.url ? new URL(tab.url).origin : "";
    const sourceUrl = origin ? `${origin}/watch?v=${target.id}` : target.id;

    const content = Parser.formatCuesOutput(
      cap.cues,
      {
        heading: target.title,
        sublines: [
          `**Source:** ${sourceUrl}`,
          `**Captions:** ${cap.langCode} (${cap.isGenerated ? "auto-generated" : "manual"})`
        ]
      },
      S.settings
    );

    if (copyOnly) {
      return { ok: true, content, lines: cap.cues.length };
    }

    const res = await Hud.downloadVerified(
      Parser.toSubtitleDataUrl(content, ext),
      filename,
      S.settings.saveAs
    );
    return res.ok ? { ok: true, filename, size: res.size, lines: cap.cues.length } : { ok: false, error: res.error };
  }

  /**
   * Execute batch playlist download pipeline using a concurrent worker pool.
   */
  async function runPlaylistPipeline(tabId, S, helpers) {
    const { plLedgerFor, saveState, setPlStatus, stopRun } = helpers;
    const scan = await scanPlaylistPage(tabId, S, setPlStatus, true);
    if (!scan.ok || !S.plVideos.length) {
      return stopRun(scan.reason || "No video or playlist found on this tab.");
    }

    const rangeStart = Math.max(1, Number(S.plRangeStart) || 1);
    const rangeEnd = Math.min(S.plVideos.length, Number(S.plRangeEnd) || S.plVideos.length);
    const activeVideos = S.plVideos.filter((v) => v.pos >= rangeStart && v.pos <= Math.max(rangeStart, rangeEnd));

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const origin = tab && tab.url ? new URL(tab.url).origin : "";
    const led = plLedgerFor(S.plKey);
    const maxPasses = S.plIsPlaylist ? 2 : 1;
    const ext = (S.settings.exportFormat || "md").toLowerCase();
    const targetExt = "." + ext;
    const useExact = S.settings.namingMode !== "prefix";
    const folderName = getPlaylistFolderName(S);
    // Only prompt Save As on single-video downloads; batch playlists save cleanly into their subfolder
    const promptSaveAs = !S.plIsPlaylist && activeVideos.length === 1 && !!S.settings.saveAs;
    const concurrency = promptSaveAs ? 1 : 4;

    for (let pass = 1; pass <= maxPasses && S.enabled; pass++) {
      const todo = activeVideos.filter(
        (v) => !led[v.pos] || !led[v.pos].ok || !String(led[v.pos].file || "").endsWith(targetExt)
      );
      if (!todo.length) break;
      if (pass > 1) {
        setPlStatus(`Retrying ${todo.length} video(s)...`);
        await Config.sleep(800);
      }

      let cursor = 0;
      const processOne = async (item) => {
        if (!S.enabled) return;
        setPlStatus(`Downloading [${item.pos}/${S.plVideos.length}]: ${item.title.slice(0, 50)}...`);

        let cap = await fetchVideoCaptions(tabId, item.id, S.plLangs);
        if ((!cap || !cap.ok) && activeVideos.length === 1) {
          // Last resort for a single video: use the subtitle track YouTube's own player already loaded
          // (captured by the page interceptor when captions are switched on).
          try {
            const best = Registry.getTabTracks(tabId)
              .filter((t) => t && ((t.cues && t.cues.length >= 2) || (t.url && /^https?:/i.test(t.url))))
              .sort((a, b) => ((b.cues && b.cues.length) || 0) - ((a.cues && a.cues.length) || 0))[0];
            if (best) {
              const regCues = await Registry.resolveTrackCues(tabId, best);
              if (regCues && regCues.length >= 2) {
                cap = { ok: true, cues: regCues, langCode: best.lang || "en", isGenerated: /auto/i.test(best.label || "") };
              }
            }
          } catch (_) {}
        }
        if (!cap || !cap.ok) {
          const err = (cap && cap.error) || "could not fetch captions";
          led[item.pos] = { ok: false, error: err };
          setPlStatus(`#${item.pos} failed: ${err}`);
          return;
        }

        const numStr = String(item.pos).padStart(2, "0");
        const relPath = useExact
          ? S.plIsPlaylist
            ? `${folderName}/${numStr} - ${Config.exactFileName(item.title, `Video ${numStr}`)}.${ext}`
            : `${Config.exactFileName(item.title, `Video ${numStr}`)}.${ext}`
          : S.plIsPlaylist
          ? `${folderName}/${folderName}_Episode_${numStr}_Transcript.${ext}`
          : `${folderName}_${Config.safeName(item.title, item.id)}_Transcript.${ext}`;

        const filename = Config.buildDownloadPath(relPath, S.settings.downloadFolder);
        const sourceUrl = origin ? `${origin}/watch?v=${item.id}` : item.id;

        const content = Parser.formatCuesOutput(
          cap.cues,
          {
            heading: useExact
              ? item.title
              : `${folderName.replace(/_/g, " ")} - ${S.plIsPlaylist ? `Episode ${item.pos} ` : ""}Full Transcript`,
            sublines: [
              ...(S.plIsPlaylist ? [`**Episode:** ${item.pos} | **Playlist:** ${S.plTitle}`] : []),
              `**Video Title:** ${item.title}`,
              `**Source:** ${sourceUrl}`,
              `**Captions:** ${cap.langCode} (${cap.isGenerated ? "auto-generated" : "manual"})`
            ]
          },
          S.settings
        );

        const res = await Hud.downloadVerified(
          Parser.toSubtitleDataUrl(content, ext),
          filename,
          promptSaveAs
        );
        if (!res.ok) {
          led[item.pos] = { ok: false, error: res.error };
          setPlStatus(`#${item.pos} save failed (${res.error})`);
        } else {
          led[item.pos] = {
            ok: true,
            file: filename,
            size: res.size,
            lines: cap.cues.length,
            downloadId: res.id,
            lang: `${cap.langCode} (${cap.isGenerated ? "auto" : "manual"})`
          };
          setPlStatus(`Saved #${item.pos}: ${item.title.slice(0, 42)} (${cap.cues.length} cues)`);
        }
      };

      const workers = Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
        while (S.enabled && cursor < todo.length) {
          const idx = cursor++;
          await processOne(todo[idx]);
          await saveState();
        }
      });
      await Promise.all(workers);
    }

    await Hud.verifyLedgerDownloads(led);
    await saveState();

    const targets = activeVideos;
    const done = targets.filter((v) => led[v.pos] && led[v.pos].ok);
    const missing = targets.filter((v) => !(led[v.pos] && led[v.pos].ok));
    const destDir = Config.buildDownloadPath(folderName, S.settings.downloadFolder);

    if (S.plIsPlaylist && S.settings.saveReport !== false) {
      const reportMd = Parser.buildDownloadReport({
        heading: `${S.plTitle} - Download Report`,
        totalLabel: "Videos in playlist",
        totalCount: targets.length,
        savedCount: done.length,
        missingIds: missing.map((v) => v.pos),
        idHeader: "#",
        countHeader: "Lines",
        rows: targets.map((v) => {
          const r = led[v.pos];
          return {
            id: v.pos,
            title: v.title || "",
            ok: !!(r && r.ok),
            size: r && r.size,
            count: r && r.lines,
            note: r && r.lang,
            error: r && r.error
          };
        })
      });
      await Hud.downloadVerified(
        Parser.toSubtitleDataUrl(reportMd, "md"),
        `${destDir}/_Download_Report.md`,
        false
      );
    }

    const firstMissingErr =
      missing.length === 1 && led[missing[0].pos] && led[missing[0].pos].error
        ? ` (${led[missing[0].pos].error})`
        : "";

    stopRun(
      missing.length
        ? `Saved ${done.length}/${targets.length} videos. Missing: #${missing.map((v) => v.pos).join(", #")}${firstMissingErr}.`
        : S.plIsPlaylist
        ? `Saved to Downloads/${destDir}/`
        : `Saved to Downloads/${Config.buildDownloadPath("", S.settings.downloadFolder)}`
    );
  }

  root.SubPlaylistPipeline = Object.freeze({
    scanPlaylistPage,
    fetchVideoCaptions,
    downloadSingleVideo,
    runPlaylistPipeline
  });
})(self);
