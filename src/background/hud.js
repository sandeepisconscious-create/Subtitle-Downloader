// @ts-check
/**
 * Tab Script Injection, On-Page Progress HUD & Verified Download Helpers.
 */

(function (root) {
  const ignoreErr = () => void chrome.runtime.lastError;

  /**
   * Execute a function inside the target tab's isolated world.
   * @template T
   * @param {number} tabId
   * @param {(...args: any[]) => T | Promise<T>} func
   * @param {any[]} [args=[]]
   * @param {number | null} [frameId=null]
   * @returns {Promise<T | null>}
   */
  async function inject(tabId, func, args = [], frameId = null) {
    try {
      const target = typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId };
      const r = await chrome.scripting.executeScript({ target, func, args });
      return r && r[0] ? /** @type {T} */ (r[0].result) : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Execute an arbitrary function across all frames in the target tab.
   * @template T
   * @param {number} tabId
   * @param {(...args: any[]) => T | Promise<T>} func
   * @param {any[]} [args=[]]
   * @returns {Promise<Array<{ frameId: number, result: T }>>}
   */
  async function injectAllFrames(tabId, func, args = []) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func,
        args
      });
      return r ? r.map((entry) => ({ frameId: entry.frameId, result: /** @type {T} */ (entry.result) })) : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Execute a function inside the target tab's MAIN world (for reading player state / globals).
   * @template T
   * @param {number} tabId
   * @param {(...args: any[]) => T | Promise<T>} func
   * @param {any[]} [args=[]]
   * @returns {Promise<T | null>}
   */
  async function injectMain(tabId, func, args = []) {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
      return r && r[0] ? /** @type {T} */ (r[0].result) : null;
    } catch (_) {
      return null;
    }
  }

  /** @type {Map<number, string>} */
  const lastBadgeByTab = new Map();

  /**
   * Set the toolbar badge text for a tab (e.g. "1" for a single video, "N" for an N-video playlist, or "" to clear).
   * @param {number} tabId
   * @param {string} text
   */
  function setTabBadge(tabId, text) {
    if (typeof tabId !== "number" || tabId < 0) return;
    const val = String(text || "");
    if (lastBadgeByTab.get(tabId) === val) return;
    lastBadgeByTab.set(tabId, val);
    chrome.action.setBadgeText({ tabId, text: val }, ignoreErr);
    if (val) {
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#10b981" }, ignoreErr);
    }
  }

  /**
   * Remove the floating progress HUD from a tab.
   * @param {number} tabId
   */
  async function removeHud(tabId) {
    await inject(tabId, () => {
      const hud = document.getElementById("subtitle-downloader-hud");
      if (hud) hud.remove();
    });
  }

  /** @type {Map<number, number>} */
  const lastHudUpdateAt = new Map();

  /**
   * Render or update the floating progress HUD on the active video page.
   * Throttles intermediate updates during high-concurrency batch runs while always flushing final state.
   * @param {number} tabId
   * @param {string} message
   * @param {number} doneCount
   * @param {number | null} total
   * @param {boolean} running
   * @param {boolean} [enabledInSettings=true]
   */
  async function showHud(tabId, message, doneCount, total, running, enabledInSettings = true) {
    if (!enabledInSettings || tabId == null) return;
    const now = Date.now();
    if (running && now - (lastHudUpdateAt.get(tabId) || 0) < 220) return;
    lastHudUpdateAt.set(tabId, now);
    await inject(
      tabId,
      (msg, done, tot, run) => {
        let hud = document.getElementById("subtitle-downloader-hud");
        if (!hud) {
          hud = document.createElement("div");
          hud.id = "subtitle-downloader-hud";
          hud.style.cssText =
            "position:fixed;top:72px;left:24px;z-index:2147483647;background:rgba(18,18,21,.95);border:1px solid #27272a;color:#fafafa;padding:12px 16px;border-radius:12px;font:12px/1.5 -apple-system,BlinkMacSystemFont,'Inter',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:360px;pointer-events:none;backdrop-filter:blur(8px);-webkit-font-smoothing:antialiased;";
          if (document.body) document.body.appendChild(hud);
        }
        hud.style.borderColor = run ? "#3b82f6" : "#27272a";
        hud.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px;">
            <div style="font-weight:600;color:#3b82f6;font-size:11px;letter-spacing:0.02em;text-transform:uppercase;">Subtitle Downloader · ${done}${tot ? " / " + tot : ""} saved</div>
            ${run ? `<button id="sub-hud-skip" style="pointer-events:auto;background:rgba(255,255,255,0.12);border:1px solid #3f3f46;color:#fafafa;border-radius:6px;padding:2px 8px;font-size:10.5px;font-weight:600;cursor:pointer;line-height:14px;user-select:none;">⏭ Skip</button>` : ""}
          </div>
          <div style="line-height:16px;color:#a1a1aa;font-size:12px;">${msg}</div>
        `;
        const skipBtn = hud.querySelector("#sub-hud-skip");
        if (skipBtn) {
          skipBtn.onclick = (e) => {
            e.stopPropagation();
            skipBtn.textContent = "Skipping...";
            skipBtn.style.opacity = "0.5";
            try {
              chrome.runtime.sendMessage({ action: "skipCurrentEpisode" });
            } catch (_) {}
          };
        }
      },
      [message, doneCount, total, running]
    );
  }

  /** @type {Map<number, string>} */
  const expectedFilenames = new Map();

  if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
      const targetName = expectedFilenames.get(item.id);
      if (targetName) {
        expectedFilenames.delete(item.id);
        suggest({ filename: targetName, conflictAction: "overwrite" });
        return;
      }
      if (item.byExtensionId === chrome.runtime.id && item.filename) {
        suggest({ filename: item.filename, conflictAction: "overwrite" });
      }
    });
  }

  /**
   * Trigger a browser download and verify completion and non-zero size on disk.
   * @param {string} url
   * @param {string} filename
   * @param {boolean} [promptSaveAs=false]
   * @returns {Promise<{ ok: boolean, id?: number, size?: number, error?: string }>}
   */
  function downloadVerified(url, filename, promptSaveAs = false) {
    const attemptDownload = (targetFilename) =>
      new Promise((resolve) => {
        chrome.downloads.download(
          { url, filename: targetFilename, conflictAction: "overwrite", saveAs: !!promptSaveAs },
          (id) => {
            if (chrome.runtime.lastError || id === undefined) {
              return resolve({ ok: false, error: chrome.runtime.lastError?.message || "no id" });
            }
            expectedFilenames.set(id, targetFilename);
            let done = false;
            const finish = (res) => {
              if (done) return;
              done = true;
              expectedFilenames.delete(id);
              chrome.downloads.onChanged.removeListener(onChg);
              resolve(res);
            };
            const check = () =>
              chrome.downloads.search({ id }, (r) => {
                const it = r && r[0];
                if (it && it.state === "complete" && it.exists !== false && it.fileSize > 0) {
                  finish({ ok: true, id, size: it.fileSize });
                } else if (it && it.state === "interrupted") {
                  finish({ ok: false, error: it.error || "interrupted" });
                }
              });
            const onChg = (d) => {
              if (d.id === id && d.state) check();
            };
            chrome.downloads.onChanged.addListener(onChg);
            setTimeout(
              () => finish({ ok: false, error: "timeout waiting for file" }),
              promptSaveAs ? 120000 : 30000
            );
            check();
          }
        );
      });

    return attemptDownload(filename).then((res) => {
      if (!res.ok && /invalid filename/i.test(res.error || "")) {
        const asciiSafe = String(filename || "Transcript.md")
          .split("/")
          .map((seg) =>
            seg
              .replace(/[^\x20-\x7E]+/g, "")
              .replace(/[\\/:*?"<>|]+/g, " - ")
              .replace(/\s+/g, " ")
              .replace(/^[.\s]+|[.\s]+$/g, "")
              .trim() || "Transcript"
          )
          .join("/");
        if (asciiSafe && asciiSafe !== filename) {
          return attemptDownload(asciiSafe);
        }
      }
      return res;
    });
  }

  /**
   * Re-verify all completed download records in a ledger against disk existence in parallel.
   * @param {Record<string | number, any>} ledger
   * @returns {Promise<void>}
   */
  async function verifyLedgerDownloads(ledger) {
    if (!ledger || typeof ledger !== "object") return;
    const keys = Object.keys(ledger).filter((k) => {
      const rec = ledger[k];
      return rec && rec.ok && rec.downloadId != null;
    });
    await Promise.all(
      keys.map(async (k) => {
        const rec = ledger[k];
        const items = await new Promise((r) => chrome.downloads.search({ id: rec.downloadId }, r));
        const it = items && items[0];
        if (!it || it.state !== "complete" || it.exists === false) {
          ledger[k] = { ok: false, error: "file not found on disk" };
        }
      })
    );
  }

  /**
   * Fetch a YouTube caption track from inside the page using:
   *  1. Performance Resource Timing URLs (which already carry YouTube's live PO token `&pot=...`),
   *  2. Multi-client Innertube `/youtubei/v1/player` fallback (`ANDROID`, `IOS`) with both `omit` and `include` credentials,
   *  3. Active player CC trigger + resource harvest if all API endpoints return empty.
   * @param {number} tabId
   * @param {string} videoId
   * @param {string[]} langs
   * @returns {Promise<{ ok: boolean, rawBody?: string, hintExt?: string, langCode?: string, isGenerated?: boolean, error?: string }>}
   */
  async function fetchYoutubeCaptionsViaTab(tabId, videoId, langs) {
    const res = await injectMain(
      tabId,
      async (vid, prefLangs) => {
        try {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const match = (tl, tg) => {
            const a = String(tl || "").toLowerCase();
            const b = String(tg || "").replace(/:asr$/i, "").replace(/^tlang:/i, "").toLowerCase();
            return a === b || a.startsWith(b + "-");
          };
          let translateTo = "";
          for (const l of prefLangs || []) {
            if (/^tlang:/i.test(l)) {
              translateTo = String(l).replace(/^tlang:/i, "").trim();
              break;
            }
          }

          const tryFetchTimedtext = async (rawUrl) => {
            const base = String(rawUrl || "").replace(/&fmt=[^&]+/g, "");
            const targetBase = translateTo
              ? `${base.replace(/&tlang=[^&]+/g, "")}&tlang=${encodeURIComponent(translateTo)}`
              : base;
            for (const cred of /** @type {RequestCredentials[]} */ (["include", "omit"])) {
              for (const suffix of ["&fmt=json3", "", "&fmt=srv3"]) {
                const r = await fetch(targetBase + suffix, { credentials: cred }).catch(() => null);
                if (r && r.ok) {
                  const body = await r.text();
                  if (body && body.trim() && body.trim().length > 20) {
                    return {
                      body,
                      hintExt: suffix === "&fmt=json3" || body.trim().startsWith("{") ? "timedtext.json3" : "timedtext.xml"
                    };
                  }
                }
              }
            }
            return null;
          };

          // 1. Check Performance Resource Timing for a live timedtext request with a valid PO token (&pot=...)
          const harvestPerformanceTimedtext = async () => {
            if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return null;
            const entries = performance.getEntriesByType("resource") || [];
            const candidates = [];
            for (let i = entries.length - 1; i >= 0; i--) {
              const u = entries[i] && entries[i].name;
              if (u && /\/api\/timedtext/i.test(u) && (!vid || u.includes(`v=${vid}`))) {
                candidates.push(u);
              }
            }
            for (const u of candidates) {
              const hit = await tryFetchTimedtext(u);
              if (hit) {
                const langM = u.match(/[?&]lang=([^&]+)/i);
                const kindM = u.match(/[?&]kind=([^&]+)/i);
                const langCode = langM ? decodeURIComponent(langM[1]) : "en";
                return {
                  ok: true,
                  rawBody: hit.body,
                  hintExt: hit.hintExt,
                  langCode: translateTo ? `${langCode}→${translateTo}` : langCode,
                  isGenerated: translateTo ? true : !!(kindM && /asr/i.test(kindM[1]))
                };
              }
            }
            return null;
          };

          const perfHit = await harvestPerformanceTimedtext();
          if (perfHit) return perfHit;

          // 2. Multi-client Innertube /youtubei/v1/player fallback (ANDROID + IOS, omit + include credentials)
          const clients = [
            { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34 },
            { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2" }
          ];
          const diagErrors = [];
          for (const client of clients) {
            for (const cred of /** @type {RequestCredentials[]} */ (["omit", "include"])) {
              try {
                const resp = await fetch("/youtubei/v1/player?prettyPrint=false", {
                  method: "POST",
                  credentials: cred,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    context: { client },
                    videoId: vid
                  })
                });
                if (!resp.ok) {
                  diagErrors.push(`${client.clientName}(${cred}): HTTP ${resp.status}`);
                  continue;
                }
                const data = await resp.json();
                const status = data?.playabilityStatus?.status;
                const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                if (!Array.isArray(tracks) || !tracks.length) {
                  diagErrors.push(`${client.clientName}(${cred}): status=${status || "unknown"}`);
                  continue;
                }
                let chosen = null;
                for (const l of prefLangs || []) {
                  const wantsAutoOnly = /:asr$/i.test(l);
                  chosen = tracks.find(
                    (t) => (wantsAutoOnly ? t.kind === "asr" : t.kind !== "asr") && match(t.languageCode, l)
                  );
                  if (chosen) break;
                }
                if (!chosen) {
                  for (const l of prefLangs || []) {
                    chosen = tracks.find((t) => match(t.languageCode, l));
                    if (chosen) break;
                  }
                }
                if (!chosen) chosen = tracks.find((t) => t.kind !== "asr") || tracks[0];
                if (chosen && chosen.baseUrl) {
                  const hit = await tryFetchTimedtext(chosen.baseUrl);
                  if (hit) {
                    return {
                      ok: true,
                      rawBody: hit.body,
                      hintExt: hit.hintExt,
                      langCode: translateTo
                        ? `${chosen.languageCode || "auto"}→${translateTo}`
                        : chosen.languageCode || "en",
                      isGenerated: translateTo ? true : chosen.kind === "asr"
                    };
                  }
                  diagErrors.push(`${client.clientName}(${cred}): timedtext 0B`);
                }
              } catch (err) {
                diagErrors.push(`${client.clientName}(${cred}): ${err && err.message ? err.message : "err"}`);
              }
            }
          }

          // 3. Last resort: trigger YouTube's own player to load captions (generating a fresh &pot= URL)
          try {
            const mp = /** @type {any} */ (document.getElementById("movie_player"));
            if (mp) {
              if (typeof mp.loadModule === "function") mp.loadModule("captions");
              if (typeof mp.toggleSubtitlesOn === "function") mp.toggleSubtitlesOn();
            }
            const ccBtn = /** @type {HTMLElement | null} */ (document.querySelector(".ytp-subtitles-button"));
            if (ccBtn && ccBtn.getAttribute("aria-pressed") === "false") {
              ccBtn.click();
            }
            await wait(700);
            const latePerfHit = await harvestPerformanceTimedtext();
            if (latePerfHit) return latePerfHit;
          } catch (_) {}

          return { ok: false, error: diagErrors.join("; ") || "caption download returned 0 bytes" };
        } catch (e) {
          return { ok: false, error: e && e.message ? e.message : String(e) };
        }
      },
      [videoId, langs]
    );
    return res || { ok: false, error: "could not run page fetch (tab not accessible)" };
  }

  root.SubHud = Object.freeze({
    ignoreErr,
    inject,
    injectAllFrames,
    injectMain,
    fetchYoutubeCaptionsViaTab,
    setTabBadge,
    removeHud,
    showHud,
    downloadVerified,
    verifyLedgerDownloads
  });
})(self);
