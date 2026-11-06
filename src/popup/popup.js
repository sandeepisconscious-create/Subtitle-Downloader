// @ts-check
/**
 * Popup UI Controller.
 * Manages theme/settings preferences and renders the 3 context-aware views
 * (Playlist/Video, Episodic Season, and Universal Subtitle Stream).
 */

document.addEventListener("DOMContentLoaded", async () => {
  const Config = window.SubConfig;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !Config) return;

  const send = (msg) =>
    new Promise((resolve) =>
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res);
      })
    );

  // ---------- Load Settings & Theme ----------
  const stored = await chrome.storage.local.get([
    Config.STORAGE_KEYS.SETTINGS,
    Config.STORAGE_KEYS.SEASON_PREFIX,
    Config.STORAGE_KEYS.PLAYLIST_PREFIX
  ]);
  /** @type {import('../core/config.js').UserSettings} */
  const settings = { ...Config.DEFAULT_SETTINGS, ...(stored[Config.STORAGE_KEYS.SETTINGS] || {}) };

  const applyTheme = (theme) => {
    document.body.setAttribute("data-theme", theme);
    document.querySelectorAll(".theme-opt").forEach((b) => {
      b.classList.toggle("active", /** @type {HTMLElement} */ (b).dataset.themeVal === theme);
    });
  };
  applyTheme(settings.theme);

  const plPrefixRow = /** @type {HTMLElement} */ (document.getElementById("plPrefixRow"));
  const plNamingButtons = document.querySelectorAll(".pl-naming-opt");
  const plPrefixInput = /** @type {HTMLInputElement} */ (document.getElementById("plPrefix"));
  const plDestText = /** @type {HTMLElement} */ (document.getElementById("plDestText"));
  const genDestRow = /** @type {HTMLElement} */ (document.getElementById("genDestRow"));
  const genDestText = /** @type {HTMLElement} */ (document.getElementById("genDestText"));
  const rowTimestamps = /** @type {HTMLElement} */ (document.getElementById("rowTimestamps"));
  const rowHeader = /** @type {HTMLElement} */ (document.getElementById("rowHeader"));
  const rowDownloadFolder = /** @type {HTMLElement} */ (document.getElementById("rowDownloadFolder"));
  const folderSub = /** @type {HTMLElement} */ (document.getElementById("folderSub"));
  const plLangRow = /** @type {HTMLElement} */ (document.getElementById("plLangRow"));
  const plLangSelect = /** @type {HTMLSelectElement} */ (document.getElementById("plLangSelect"));
  const plRangeRow = /** @type {HTMLElement} */ (document.getElementById("plRangeRow"));
  const plRangeStart = /** @type {HTMLInputElement} */ (document.getElementById("plRangeStart"));
  const plRangeEnd = /** @type {HTMLInputElement} */ (document.getElementById("plRangeEnd"));
  const langSettingSub = /** @type {HTMLElement} */ (document.getElementById("langSettingSub"));
  const seasonInput = /** @type {HTMLInputElement} */ (document.getElementById("seasonNum"));
  const prefixInput = /** @type {HTMLInputElement} */ (document.getElementById("prefix"));
  const seasonDestRow = /** @type {HTMLElement | null} */ (document.getElementById("seasonDestRow"));
  const seasonDestText = /** @type {HTMLElement | null} */ (document.getElementById("seasonDestText"));
  const seasonNamingPreview = /** @type {HTMLElement | null} */ (
    document.getElementById("seasonNamingPreview")
  );
  let seasonNamingMode = stored[Config.STORAGE_KEYS.SEASON_NAMING_MODE] || "numbered";
  let latestSeasonMap = null;
  let currentPlaylistTitle = "";
  let currentIsPlaylist = false;
  let lastPlaylistTotal = 0;
  let lastGenericSignature = "";
  let lastLangSignature = "";
  const cleanTabTitle = Config.cleanPageTitle(tab.title, "Current Video");
  const cleanSeriesTitle = Config.cleanShowTitle(tab.title, "Series");

  /**
   * Shared helper to render progress bars, counts, and missing banners for Playlist and Season views.
   * @param {{
   *   box: HTMLElement,
   *   barFill: HTMLElement,
   *   pctText: HTMLElement,
   *   countText: HTMLElement,
   *   statusTextEl: HTMLElement,
   *   missingBanner: HTMLElement
   * }} els
   * @param {{
   *   running: boolean,
   *   doneCount: number,
   *   total: number,
   *   isSingle: boolean,
   *   statusMessage: string,
   *   missingList: Array<string | number>,
   *   singularLabel: string,
   *   pluralLabel: string,
   *   missingPrefix: string
   * }} state
   */
  const renderProgressBox = (els, state) => {
    const hasFailedAttempt = !state.running && state.doneCount === 0 && /^Saved 0\/|failed|error/i.test(state.statusMessage || "");
    const hasProgress = state.running || state.doneCount > 0 || hasFailedAttempt;
    const allDone = state.total > 0 && state.doneCount >= state.total;
    const hasMissing = !state.running && (state.doneCount > 0 || hasFailedAttempt) && state.missingList.length > 0;

    els.box.classList.toggle("visible", hasProgress);
    if (!hasProgress) return;

    const pct = state.total
      ? Math.min(100, Math.round((state.doneCount / state.total) * 100))
      : 0;
    els.barFill.style.width = `${pct}%`;
    els.pctText.textContent = `${pct}%`;

    if (state.running) {
      els.countText.textContent = `Downloading ${state.doneCount}${state.total ? " of " + state.total : ""}...`;
      els.countText.style.color = "var(--text-primary)";
    } else if (allDone) {
      els.countText.textContent = state.isSingle
        ? `✓ ${state.singularLabel} Saved`
        : `✓ All ${state.total} ${state.pluralLabel} Saved`;
      els.countText.style.color = "var(--success)";
    } else {
      els.countText.textContent = state.total
        ? `${state.doneCount} of ${state.total} Saved`
        : `${state.doneCount} Saved`;
      els.countText.style.color = "var(--text-primary)";
    }

    els.statusTextEl.textContent = state.statusMessage || "";
    if (hasMissing) {
      els.missingBanner.style.display = "block";
      els.missingBanner.textContent = `${state.missingPrefix}${state.missingList.join(", ")}`;
    } else {
      els.missingBanner.style.display = "none";
    }
  };

  /**
   * Bind a Copy-to-Clipboard action button with consistent loading/feedback state.
   * @param {HTMLButtonElement | null} btn
   * @param {() => Promise<{ ok?: boolean, content?: string, count?: number, error?: string }>} fetchCopyPayload
   * @param {string} unitName
   */
  const bindCopyButton = (btn, fetchCopyPayload, unitName) => {
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Copying transcript...";
      const r = await fetchCopyPayload();
      if (r && r.ok && r.content) {
        await navigator.clipboard.writeText(r.content);
        btn.textContent = `✓ Copied to Clipboard (${r.count || 0} ${unitName})`;
      } else {
        btn.textContent = `Failed: ${(r && r.error) || "error"}`;
      }
      btn.disabled = false;
      setTimeout(() => {
        if (!btn.disabled) btn.textContent = "Copy Transcript to Clipboard";
      }, 2500);
    });
  };

  const updateDestLine = () => {
    const fmt = (settings.exportFormat || "md").toUpperCase();
    const ext = fmt.toLowerCase();
    const baseDir = (settings.downloadFolder || "").trim().replace(/^\/+|\/+$/g, "");
    if (rowDownloadFolder) {
      rowDownloadFolder.style.display = settings.saveAs ? "none" : "flex";
    }
    if (folderSub) {
      folderSub.textContent = baseDir
        ? `Creates Downloads/${baseDir}/ automatically`
        : `Saves directly inside your Downloads folder`;
    }
    const isPrefix = settings.namingMode === "prefix";
    const targetName =
      isPrefix && plPrefixInput.value.trim()
        ? Config.safeName(plPrefixInput.value.trim(), "Transcripts")
        : Config.exactFileName(currentPlaylistTitle || cleanTabTitle, "Transcript");
    const rootPath = baseDir ? `Downloads/${baseDir}/` : `Downloads/`;

    if (settings.saveAs && !currentIsPlaylist) {
      plDestText.textContent = `Ask where to save · .${fmt}`;
    } else if (currentIsPlaylist) {
      plDestText.textContent = `${rootPath}${targetName}/ · .${fmt}`;
    } else {
      plDestText.textContent = `${rootPath}${targetName.slice(0, 34)}.${ext}`;
    }

    if (genDestText) {
      if (settings.saveAs) {
        genDestText.textContent = `Ask where to save · .${fmt}`;
      } else {
        genDestText.textContent = `${rootPath}${cleanTabTitle.slice(0, 32)}.${ext}`;
      }
    }

    if (seasonDestText && prefixInput) {
      const showTitle = Config.exactFileName(prefixInput.value.trim(), "Series");
      const sNum = parseInt(seasonInput?.value || "1", 10) || 1;
      if (settings.saveAs) {
        seasonDestText.textContent = `Ask where to save · ${showTitle}/Season ${sNum}/`;
      } else {
        seasonDestText.textContent = `${rootPath}${showTitle}/Season ${sNum}/ · .${fmt}`;
      }
    }
    if (seasonNamingPreview && prefixInput) {
      const showTitle = Config.exactFileName(prefixInput.value.trim(), "Series");
      const sNum = parseInt(seasonInput?.value || "1", 10) || 1;
      if (seasonNamingMode === "original") {
        const ep1 = latestSeasonMap && (latestSeasonMap[1] || latestSeasonMap["1"]);
        const ep1Title = ep1 && ep1.title ? Config.exactFileName(ep1.title, "") : "";
        const sampleTitle = ep1Title ? ep1Title : "Uploader's Video Title";
        seasonNamingPreview.textContent = `E01 - ${sampleTitle}.${ext}`;
      } else {
        seasonNamingPreview.textContent = `${showTitle} Season ${sNum} - Episode 01.${ext}`;
      }
    }
  };

  const timestampsSub = document.getElementById("timestampsSub");
  const headerSub = document.getElementById("headerSub");
  const stripSoundsSub = document.getElementById("stripSoundsSub");
  const saveAsSub = document.getElementById("saveAsSub");
  const reportSub = document.getElementById("reportSub");
  const hudSub = document.getElementById("hudSub");
  const formatSub = document.getElementById("formatSub");

  const syncSettingsSubtexts = () => {
    if (timestampsSub) {
      timestampsSub.textContent = setTimestamps.checked
        ? "ON — Shows [00:01:23] timecodes before each line"
        : "OFF — Clean paragraphs without timecodes (reads like a book)";
    }
    if (saveAsSub) {
      saveAsSub.textContent = setSaveAs.checked
        ? "ON — Shows folder picker dialog before each download"
        : "OFF — Saves directly into Downloads folder without asking";
    }
    if (headerSub) {
      headerSub.textContent = setHeader.checked
        ? "ON — Includes video title and link at top of the file"
        : "OFF — Saves only the transcript dialogue, no header";
    }
    if (stripSoundsSub && setStripSounds) {
      stripSoundsSub.textContent = setStripSounds.checked
        ? "ON — Removes sound tags like [Music], [Applause], [संगीत]"
        : "OFF — Keeps sound descriptions in the text";
    }
    if (reportSub) {
      reportSub.textContent = setReport.checked
        ? "ON — Creates _Download_Report.md summary table after batch runs"
        : "OFF — Saves only transcripts, no summary file";
    }
    if (hudSub) {
      hudSub.textContent = setHud.checked
        ? "ON — Shows floating progress bar on the video page"
        : "OFF — Hidden on the video page";
    }
    if (formatSub) {
      const fmt = (settings.exportFormat || "md").toLowerCase();
      if (fmt === "md") {
        formatSub.textContent = "Markdown (.md) — Clean formatted notes for reading, Notion, and AI";
      } else if (fmt === "txt") {
        formatSub.textContent = "Plain Text (.txt) — Simple raw text without styling";
      } else if (fmt === "srt") {
        formatSub.textContent = "SubRip (.srt) — Standard subtitle file for video players & Premiere";
      } else if (fmt === "vtt") {
        formatSub.textContent = "WebVTT (.vtt) — Web subtitle format for video players";
      }
    }
    if (folderSub) {
      const baseDir = (settings.downloadFolder || "").trim().replace(/^\/+|\/+$/g, "");
      folderSub.textContent = baseDir
        ? `Saves inside Downloads/${baseDir}/ automatically`
        : `Saves directly inside your Downloads folder`;
    }
  };

  const applyFormatUI = (fmt) => {
    document.querySelectorAll(".format-opt").forEach((b) => {
      b.classList.toggle("active", /** @type {HTMLElement} */ (b).dataset.formatVal === fmt);
    });
    const isTextDoc = fmt === "md" || fmt === "txt";
    if (rowTimestamps) rowTimestamps.style.display = isTextDoc ? "flex" : "none";
    if (rowHeader) rowHeader.style.display = isTextDoc ? "flex" : "none";
    lastGenericSignature = "";
    updateDestLine();
    syncSettingsSubtexts();
  };

  const applyNamingMode = (mode) => {
    settings.namingMode = mode === "prefix" ? "prefix" : "title";
    plNamingButtons.forEach((b) => {
      b.classList.toggle(
        "active",
        /** @type {HTMLElement} */ (b).dataset.plNaming === settings.namingMode
      );
    });
    if (plPrefixRow) {
      plPrefixRow.style.display = settings.namingMode === "prefix" ? "flex" : "none";
    }
    updateDestLine();
  };

  const saveSettings = async () => {
    await chrome.storage.local.set({ [Config.STORAGE_KEYS.SETTINGS]: settings });
    await send({ action: "updateSettings", settings, tabId: tab.id });
    updateDestLine();
  };

  // Settings Panel Controls
  const btnSettings = /** @type {HTMLButtonElement} */ (document.getElementById("btnSettings"));
  const btnCloseSettings = /** @type {HTMLButtonElement} */ (document.getElementById("btnCloseSettings"));
  const mainView = /** @type {HTMLElement} */ (document.getElementById("mainView"));
  const settingsView = /** @type {HTMLElement} */ (document.getElementById("settingsView"));
  const setDownloadFolder = /** @type {HTMLInputElement} */ (document.getElementById("setDownloadFolder"));
  const setSaveAs = /** @type {HTMLInputElement} */ (document.getElementById("setSaveAs"));
  const setTimestamps = /** @type {HTMLInputElement} */ (document.getElementById("setTimestamps"));
  const setHeader = /** @type {HTMLInputElement} */ (document.getElementById("setHeader"));
  const setStripSounds = /** @type {HTMLInputElement} */ (document.getElementById("setStripSounds"));
  const setReport = /** @type {HTMLInputElement} */ (document.getElementById("setReport"));
  const setHud = /** @type {HTMLInputElement} */ (document.getElementById("setHud"));
  const setLang = /** @type {HTMLSelectElement} */ (document.getElementById("setLang"));

  const populateLanguageDropdowns = (langs) => {
    const list = Array.isArray(langs) ? langs : [];
    const sig = list.map((l) => `${l.code}:${l.label}`).join("|");
    if (sig === lastLangSignature && setLang.options.length > 0) {
      if (plLangRow) plLangRow.style.display = list.length > 0 ? "flex" : "none";
      return;
    }
    lastLangSignature = sig;

    const currentPref = (settings.prefLang || "en").split(",")[0].trim().toLowerCase();
    let matchedCode = "";
    for (const item of list) {
      const c = String(item.code || "").toLowerCase();
      const b = String(item.baseCode || c.replace(/:asr$/, "")).toLowerCase();
      if (c === currentPref) {
        matchedCode = item.code;
        break;
      }
      if (!matchedCode && (b === currentPref || b.startsWith(currentPref + "-"))) {
        matchedCode = item.code;
      }
    }
    if (!matchedCode && list.length > 0) {
      matchedCode = list[0].code;
    }

    const buildOptions = (selectEl) => {
      if (!selectEl) return;
      selectEl.innerHTML = "";
      if (list.length === 0) {
        const opt = document.createElement("option");
        opt.value = currentPref || "en";
        opt.textContent = "Auto-detect from video";
        selectEl.appendChild(opt);
        return;
      }
      for (const item of list) {
        const opt = document.createElement("option");
        opt.value = item.code;
        opt.textContent = item.label;
        if (item.code === matchedCode) opt.selected = true;
        selectEl.appendChild(opt);
      }
    };

    buildOptions(setLang);
    buildOptions(plLangSelect);

    if (plLangRow) {
      plLangRow.style.display = list.length > 0 ? "flex" : "none";
    }
    if (langSettingSub) {
      langSettingSub.textContent =
        list.length > 0
          ? `${list.length} language${list.length === 1 ? "" : "s"} available on this video`
          : "Automatically detects languages in video";
    }
    if (matchedCode && matchedCode !== settings.prefLang) {
      settings.prefLang = matchedCode;
      chrome.storage.local.set({ [Config.STORAGE_KEYS.SETTINGS]: settings });
    }
  };

  setDownloadFolder.value = settings.downloadFolder !== undefined ? settings.downloadFolder : "Subtitles";
  setSaveAs.checked = !!settings.saveAs;
  setTimestamps.checked = settings.includeTimestamps !== false;
  setHeader.checked = settings.includeHeader !== false;
  if (setStripSounds) setStripSounds.checked = !!settings.stripSoundTags;
  setReport.checked = settings.saveReport !== false;
  setHud.checked = settings.showHud !== false;
  populateLanguageDropdowns([]);
  applyFormatUI(settings.exportFormat || "md");
  applyNamingMode(settings.namingMode || "title");
  syncSettingsSubtexts();

  const toggleSettings = (open) => {
    const show = typeof open === "boolean" ? open : !settingsView.classList.contains("active");
    settingsView.classList.toggle("active", show);
    mainView.style.display = show ? "none" : "block";
    btnSettings.classList.toggle("active", show);
    window.scrollTo({ top: 0, behavior: "instant" });
    document.body.scrollTop = 0;
    if (document.documentElement) document.documentElement.scrollTop = 0;
    const scrollBody = document.querySelector(".settings-scroll-body");
    if (scrollBody) scrollBody.scrollTop = 0;
  };

  btnSettings.addEventListener("click", () => toggleSettings());
  btnCloseSettings.addEventListener("click", () => toggleSettings(false));

  document.querySelectorAll(".format-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.exportFormat = /** @type {any} */ (/** @type {HTMLElement} */ (btn).dataset.formatVal);
      applyFormatUI(settings.exportFormat);
      saveSettings();
    });
  });

  document.querySelectorAll(".theme-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.theme = /** @type {any} */ (/** @type {HTMLElement} */ (btn).dataset.themeVal);
      applyTheme(settings.theme);
      saveSettings();
    });
  });

  plNamingButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = /** @type {HTMLElement} */ (btn).dataset.plNaming;
      applyNamingMode(mode || "title");
      saveSettings();
      if (mode === "prefix" && plPrefixInput) plPrefixInput.focus();
    });
  });

  setDownloadFolder.addEventListener("input", () => {
    settings.downloadFolder = setDownloadFolder.value.trim();
    saveSettings();
    syncSettingsSubtexts();
  });
  setSaveAs.addEventListener("change", () => {
    settings.saveAs = setSaveAs.checked;
    saveSettings();
    syncSettingsSubtexts();
  });
  setTimestamps.addEventListener("change", () => {
    settings.includeTimestamps = setTimestamps.checked;
    saveSettings();
    syncSettingsSubtexts();
  });
  setHeader.addEventListener("change", () => {
    settings.includeHeader = setHeader.checked;
    saveSettings();
    syncSettingsSubtexts();
  });
  if (setStripSounds) {
    setStripSounds.addEventListener("change", () => {
      settings.stripSoundTags = setStripSounds.checked;
      saveSettings();
      syncSettingsSubtexts();
    });
  }
  setReport.addEventListener("change", () => {
    settings.saveReport = setReport.checked;
    saveSettings();
    syncSettingsSubtexts();
  });
  setHud.addEventListener("change", () => {
    settings.showHud = setHud.checked;
    saveSettings();
    syncSettingsSubtexts();
  });
  setLang.addEventListener("change", () => {
    settings.prefLang = setLang.value || "en";
    if (plLangSelect && plLangSelect.value !== settings.prefLang) {
      plLangSelect.value = settings.prefLang;
    }
    saveSettings();
  });
  if (plLangSelect) {
    plLangSelect.addEventListener("change", () => {
      settings.prefLang = plLangSelect.value || "en";
      if (setLang && setLang.value !== settings.prefLang) {
        setLang.value = settings.prefLang;
      }
      saveSettings();
    });
  }

  // ---------- Detect Active Page Capability ----------
  const url = tab.url || "";
  const isPlaylistHost = /https?:\/\/(www\.|m\.|tv\.|music\.)?(youtube\.com|youtu\.be)\//i.test(url);
  const isSeasonHost =
    !isPlaylistHost &&
    (/\/(shows|series|seasons?|tv[-_]?shows?|tv)\b|\bseason=\d+/i.test(url) ||
      /https?:\/\/(www\.)?(sonyliv\.com|hotstar\.com|jiocinema\.com|netflix\.com|primevideo\.com|zee5\.com)/i.test(url));

  const views = {
    playlist: /** @type {HTMLElement} */ (document.getElementById("view-playlist")),
    season: /** @type {HTMLElement} */ (document.getElementById("view-season")),
    generic: /** @type {HTMLElement} */ (document.getElementById("view-generic"))
  };

  let activeMode = isPlaylistHost ? "playlist" : isSeasonHost ? "season" : "generic";
  const setViewMode = (mode) => {
    activeMode = mode;
    Object.keys(views).forEach((k) => views[k].classList.toggle("active", k === mode));
  };
  setViewMode(activeMode);

  // =========================================================================
  // 1. PLAYLIST / VIDEO CAPTION VIEW
  // =========================================================================
  const plPill = /** @type {HTMLElement} */ (document.getElementById("plPill"));
  const plTitle = /** @type {HTMLElement} */ (document.getElementById("plTitle"));
  const plConfigSection = /** @type {HTMLElement} */ (document.getElementById("plConfigSection"));
  const plStateBox = /** @type {HTMLElement} */ (document.getElementById("plStateBox"));
  const plCountText = /** @type {HTMLElement} */ (document.getElementById("plCountText"));
  const plPctText = /** @type {HTMLElement} */ (document.getElementById("plPctText"));
  const plBarFill = /** @type {HTMLElement} */ (document.getElementById("plBarFill"));
  const plStatusMessage = /** @type {HTMLElement} */ (document.getElementById("plStatusMessage"));
  const plMissing = /** @type {HTMLElement} */ (document.getElementById("plMissing"));
  const btnPlStart = /** @type {HTMLButtonElement} */ (document.getElementById("btnPlStart"));
  const btnPlCopy = /** @type {HTMLButtonElement} */ (document.getElementById("btnPlCopy"));
  const btnPlSingle = /** @type {HTMLButtonElement} */ (document.getElementById("btnPlSingle"));
  const btnPlScan = /** @type {HTMLButtonElement} */ (document.getElementById("btnPlScan"));
  const btnPlReset = /** @type {HTMLButtonElement} */ (document.getElementById("btnPlReset"));

  // Clear any legacy global playlist prefix so it never sticks across unrelated videos
  chrome.storage.local.remove(Config.STORAGE_KEYS.PLAYLIST_PREFIX);
  plPrefixInput.value = "";
  plPrefixInput.addEventListener("input", () => {
    updateDestLine();
  });

  const updatePlaylistStartLabel = (st) => {
    if (!st || (st.enabled && st.mode === "playlist" && st.tabId === tab.id)) return;
    const total = st.total || 0;
    const doneCount = st.done ? st.done.length : 0;
    const isSingle = total === 1 && !st.isPlaylist;
    const allDone = total > 0 && doneCount >= total;
    const hasMissing = doneCount > 0 && st.missing && st.missing.length > 0;
    const fmtLabel = (settings.exportFormat || "md").toUpperCase();

    if (allDone) {
      btnPlStart.textContent = isSingle ? `Download Again (.${fmtLabel})` : `Download All Again (${total})`;
      return;
    }
    if (hasMissing) {
      btnPlStart.textContent = `Retry ${st.missing.length} Failed Video(s)`;
      return;
    }
    if (isSingle) {
      btnPlStart.textContent = `Download Subtitle (.${fmtLabel})`;
      return;
    }
    const rStart = Math.max(1, parseInt(plRangeStart?.value || "1", 10) || 1);
    const rEnd = Math.min(total || 1, parseInt(plRangeEnd?.value || String(total || 1), 10) || total || 1);
    const rCount = Math.max(1, rEnd - rStart + 1);
    if (st.isPlaylist && total > 1 && (rStart > 1 || rEnd < total)) {
      btnPlStart.textContent = `Download ${rCount} Videos (#${rStart}–${rEnd} · .${fmtLabel})`;
    } else {
      btnPlStart.textContent = `Download All ${total || ""} Videos (.${fmtLabel})`.replace(/\s+/g, " ");
    }
  };

  if (plRangeStart && plRangeEnd) {
    const onRangeInput = () => {
      send({ action: "getPlaylistStatus", tabId: tab.id }).then((st) => updatePlaylistStartLabel(st));
    };
    plRangeStart.addEventListener("input", onRangeInput);
    plRangeEnd.addEventListener("input", onRangeInput);
  }

  function renderPlaylistView(st) {
    if (!st) return;
    const running = st.enabled && st.mode === "playlist" && st.tabId === tab.id;
    const total = st.total || 0;
    const doneCount = st.done ? st.done.length : 0;
    const isSingle = total === 1 && !st.isPlaylist;
    const allDone = total > 0 && doneCount >= total;
    const hasMissing = !running && doneCount > 0 && st.missing && st.missing.length > 0;

    currentPlaylistTitle = st.playlistTitle || "";
    currentIsPlaylist = !!st.isPlaylist;
    if (Array.isArray(st.availableLangs)) {
      populateLanguageDropdowns(st.availableLangs);
    }
    if (plRangeRow) {
      const showRange = st.isPlaylist && total > 1;
      plRangeRow.style.display = showRange ? "flex" : "none";
      if (showRange && total !== lastPlaylistTotal) {
        lastPlaylistTotal = total;
        plRangeStart.max = String(total);
        plRangeEnd.max = String(total);
        plRangeStart.value = "1";
        plRangeEnd.value = String(total);
      }
    }
    if (st.isPlaylist && total > 0) {
      plPill.textContent = `SUBTITLES AVAILABLE · PLAYLIST (${total})`;
      plPill.style.color = "var(--success)";
    } else if (total === 1) {
      plPill.textContent = "SUBTITLES AVAILABLE · VIDEO";
      plPill.style.color = "var(--success)";
    } else {
      plPill.textContent = "WAITING FOR VIDEO";
      plPill.style.color = "var(--text-tertiary)";
    }
    plTitle.textContent = st.playlistTitle || "Open a video or playlist";
    updateDestLine();

    plConfigSection.style.display = running ? "none" : "flex";
    btnPlScan.style.display = running ? "none" : "inline-flex";
    if (btnPlCopy) {
      btnPlCopy.style.display = !running && total > 0 ? "inline-flex" : "none";
    }

    renderProgressBox(
      {
        box: plStateBox,
        barFill: plBarFill,
        pctText: plPctText,
        countText: plCountText,
        statusTextEl: plStatusMessage,
        missingBanner: plMissing
      },
      {
        running,
        doneCount,
        total,
        isSingle,
        statusMessage: st.statusMessage || "",
        missingList: (st.missing || []).map((n) => `#${n}`),
        singularLabel: "Subtitle",
        pluralLabel: "Subtitles",
        missingPrefix: "Failed: "
      }
    );

    const fmtLabel = (settings.exportFormat || "md").toUpperCase();
    btnPlStart.classList.toggle("running", running);
    if (running) {
      btnPlStart.textContent = "Stop Download";
      btnPlSingle.style.display = "none";
      btnPlReset.style.display = "none";
    } else if (allDone) {
      updatePlaylistStartLabel(st);
      btnPlSingle.style.display = st.isPlaylist && st.currentVideo ? "inline-flex" : "none";
      btnPlReset.style.display = "none";
    } else if (hasMissing) {
      updatePlaylistStartLabel(st);
      btnPlSingle.style.display = "none";
      btnPlReset.style.display = "inline-flex";
    } else {
      updatePlaylistStartLabel(st);
      btnPlSingle.style.display = st.isPlaylist && st.currentVideo ? "inline-flex" : "none";
      btnPlReset.style.display = "none";
    }

    if (st.currentVideo && btnPlSingle.style.display !== "none" && !btnPlSingle.disabled) {
      btnPlSingle.textContent = `Download Current Video Only (.${fmtLabel})`;
    }
  }

  let isAutoRescanning = false;
  async function refreshPlaylist() {
    const st = await send({ action: "getPlaylistStatus", tabId: tab.id });
    const urlVidMatch = (tab.url || "").match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/watch\/)([A-Za-z0-9_-]{11})/);
    const tabVid = urlVidMatch ? urlVidMatch[1] : null;
    if (
      !isAutoRescanning &&
      st &&
      !st.enabled &&
      tabVid &&
      (!st.currentVideo || st.currentVideo.id !== tabVid || !st.availableLangs || !st.availableLangs.length)
    ) {
      isAutoRescanning = true;
      await scanPlaylist(true);
      isAutoRescanning = false;
      return;
    }
    renderPlaylistView(st);
  }

  async function scanPlaylist(quiet = false) {
    await send({ action: "scanPlaylistPage", tabId: tab.id, quiet });
    await refreshPlaylist();
  }

  btnPlScan.addEventListener("click", () => scanPlaylist(false));

  btnPlStart.addEventListener("click", async () => {
    const st = await send({ action: "getPlaylistStatus", tabId: tab.id });
    if (st && st.enabled) {
      await send({ action: "stopAutoPilot" });
    } else {
      const doneCount = st && st.done ? st.done.length : 0;
      if (st && st.total && doneCount >= st.total) {
        await send({ action: "resetPlaylistLedger", tabId: tab.id });
      }
      await send({
        action: "startPlaylist",
        tabId: tab.id,
        prefix: plPrefixInput.value,
        lang: settings.prefLang,
        rangeStart: plRangeStart ? parseInt(plRangeStart.value, 10) || 1 : 1,
        rangeEnd: plRangeEnd ? parseInt(plRangeEnd.value, 10) || 0 : 0
      });
    }
    refreshPlaylist();
  });

  bindCopyButton(
    btnPlCopy,
    async () => {
      const r = await send({
        action: "downloadSingleVideo",
        tabId: tab.id,
        prefix: plPrefixInput.value,
        lang: settings.prefLang,
        copyOnly: true
      });
      return { ok: r?.ok, content: r?.content, count: r?.lines, error: r?.error };
    },
    "lines"
  );

  btnPlSingle.addEventListener("click", async () => {
    btnPlSingle.disabled = true;
    btnPlSingle.textContent = "Saving current video...";
    const r = await send({
      action: "downloadSingleVideo",
      tabId: tab.id,
      prefix: plPrefixInput.value,
      lang: settings.prefLang
    });
    btnPlSingle.disabled = false;
    btnPlSingle.textContent = r && r.ok ? "✓ Current Video Saved" : `Failed: ${(r && r.error) || "error"}`;
    setTimeout(() => refreshPlaylist(), 2500);
  });

  btnPlReset.addEventListener("click", async () => {
    await send({ action: "resetPlaylistLedger", tabId: tab.id });
    refreshPlaylist();
  });

  // =========================================================================
  // 2. SEASON / EPISODE VIEW
  // =========================================================================
  const seasonPill = /** @type {HTMLElement} */ (document.getElementById("seasonPill"));
  const seasonTitle = /** @type {HTMLElement} */ (document.getElementById("seasonTitle"));
  const seasonConfigSection = /** @type {HTMLElement} */ (document.getElementById("seasonConfigSection"));
  const seasonStateBox = /** @type {HTMLElement} */ (document.getElementById("seasonStateBox"));
  const seasonCountText = /** @type {HTMLElement} */ (document.getElementById("seasonCountText"));
  const seasonPctText = /** @type {HTMLElement} */ (document.getElementById("seasonPctText"));
  const seasonBarFill = /** @type {HTMLElement} */ (document.getElementById("seasonBarFill"));
  const statusMessage = /** @type {HTMLElement} */ (document.getElementById("statusMessage"));
  const seasonMissing = /** @type {HTMLElement} */ (document.getElementById("seasonMissing"));
  const btnStart = /** @type {HTMLButtonElement} */ (document.getElementById("btnStart"));
  const btnSkipEpisode = /** @type {HTMLButtonElement | null} */ (document.getElementById("btnSkipEpisode"));
  const btnScan = /** @type {HTMLButtonElement} */ (document.getElementById("btnScan"));
  const btnReset = /** @type {HTMLButtonElement} */ (document.getElementById("btnReset"));
  const btnSwitchToGeneric = /** @type {HTMLButtonElement} */ (document.getElementById("btnSwitchToGeneric"));

  chrome.storage.local.remove(Config.STORAGE_KEYS.SEASON_PREFIX);
  prefixInput.value = cleanSeriesTitle || "Series";
  prefixInput.addEventListener("input", () => {
    updateDestLine();
  });
  seasonInput.addEventListener("input", () => {
    updateDestLine();
  });

  const seasonNamingButtons = document.querySelectorAll(".season-naming-opt");
  const applySeasonNamingMode = (mode) => {
    seasonNamingMode = mode === "original" ? "original" : "numbered";
    seasonNamingButtons.forEach((b) => {
      b.classList.toggle(
        "active",
        /** @type {HTMLElement} */ (b).dataset.seasonNaming === seasonNamingMode
      );
    });
    updateDestLine();
  };
  applySeasonNamingMode(seasonNamingMode);
  seasonNamingButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = /** @type {HTMLElement} */ (btn).dataset.seasonNaming;
      applySeasonNamingMode(mode);
      chrome.storage.local.set({ [Config.STORAGE_KEYS.SEASON_NAMING_MODE]: seasonNamingMode });
    });
  });

  const season = () => parseInt(seasonInput.value, 10) || null;

  function renderSeasonView(st) {
    if (!st) return;
    if (st.map) {
      latestSeasonMap = st.map;
    }
    updateDestLine();
    const running = st.enabled && st.mode === "season" && st.tabId === tab.id;
    const doneCount = st.done ? st.done.length : 0;
    const total = st.total || 0;
    const allDone = total > 0 && doneCount >= total;
    const hasMissing = !running && doneCount > 0 && st.missing && st.missing.length > 0;

    seasonPill.textContent = total
      ? `SUBTITLES AVAILABLE · SEASON (${total} EPISODES)`
      : "SUBTITLES AVAILABLE · SEASON";
    seasonTitle.textContent = st.season
      ? `${prefixInput.value.replace(/_/g, " ")} — Season ${st.season}`
      : "Select Season";

    seasonConfigSection.style.display = running ? "none" : "flex";
    btnScan.style.display = running ? "none" : "inline-flex";

    renderProgressBox(
      {
        box: seasonStateBox,
        barFill: seasonBarFill,
        pctText: seasonPctText,
        countText: seasonCountText,
        statusTextEl: statusMessage,
        missingBanner: seasonMissing
      },
      {
        running,
        doneCount,
        total,
        isSingle: false,
        statusMessage: st.statusMessage || "",
        missingList: st.missing || [],
        singularLabel: "Episode",
        pluralLabel: "Episodes",
        missingPrefix: "Failed episodes: "
      }
    );

    const fmtLabel = (settings.exportFormat || "md").toUpperCase();
    btnStart.classList.toggle("running", running);
    if (running) {
      btnStart.textContent = "Stop Download";
      if (btnSkipEpisode) btnSkipEpisode.style.display = "inline-flex";
      btnReset.style.display = "none";
    } else {
      if (btnSkipEpisode) btnSkipEpisode.style.display = "none";
      if (allDone) {
        btnStart.textContent = `Download Season Again (${total})`;
        btnReset.style.display = "none";
      } else if (hasMissing) {
        btnStart.textContent = `Retry ${st.missing.length} Failed Episode(s)`;
        btnReset.style.display = "inline-flex";
      } else {
        btnStart.textContent = total
          ? `Download All ${total} Episodes (.${fmtLabel})`
          : `Download Season (.${fmtLabel})`;
        btnReset.style.display = "none";
      }
    }
  }

  async function refreshSeason() {
    renderSeasonView(
      await send({
        action: "getAutoPilotStatus",
        season: season(),
        showTitle: prefixInput.value.trim()
      })
    );
  }

  btnStart.addEventListener("click", async () => {
    const st = await send({
      action: "getAutoPilotStatus",
      season: season(),
      showTitle: prefixInput.value.trim()
    });
    if (st && st.enabled) {
      await send({ action: "stopAutoPilot" });
    } else {
      if (!season()) {
        seasonStateBox.classList.add("visible");
        statusMessage.textContent = "Please enter the season number first.";
        return;
      }
      const doneCount = st && st.done ? st.done.length : 0;
      if (st && st.total && doneCount >= st.total) {
        await send({
          action: "resetLedger",
          season: season(),
          showTitle: prefixInput.value.trim()
        });
      }
      await send({
        action: "startAutoPilot",
        tabId: tab.id,
        season: season(),
        prefix: prefixInput.value.trim() || cleanSeriesTitle || "Series",
        seasonNamingMode
      });
    }
    refreshSeason();
  });

  if (btnSkipEpisode) {
    btnSkipEpisode.addEventListener("click", async () => {
      btnSkipEpisode.disabled = true;
      btnSkipEpisode.textContent = "⏭️ Skipping...";
      await send({ action: "skipCurrentEpisode", tabId: tab.id });
      setTimeout(() => {
        if (btnSkipEpisode) {
          btnSkipEpisode.disabled = false;
          btnSkipEpisode.textContent = "⏭️ Skip to Next Episode";
        }
      }, 1000);
    });
  }

  btnScan.addEventListener("click", async () => {
    if (!season()) return;
    btnScan.disabled = true;
    const res = await send({
      action: "scanEpisodeList",
      tabId: tab.id,
      season: season(),
      showTitle: prefixInput.value.trim()
    });
    if (res && res.info && res.info.map) {
      latestSeasonMap = res.info.map;
    }
    btnScan.disabled = false;
    refreshSeason();
  });

  btnReset.addEventListener("click", async () => {
    if (!season()) return;
    await send({
      action: "resetLedger",
      season: season(),
      showTitle: prefixInput.value.trim()
    });
    refreshSeason();
  });

  // =========================================================================
  // 3. UNIVERSAL SUBTITLE STREAM VIEW (ALL OTT & VIDEO SITES)
  // =========================================================================
  const genPill = /** @type {HTMLElement} */ (document.getElementById("genPill"));
  const genPageTitle = /** @type {HTMLElement} */ (document.getElementById("genPageTitle"));
  const genPrimaryActions = /** @type {HTMLElement} */ (document.getElementById("genPrimaryActions"));
  const btnGenBest = /** @type {HTMLButtonElement} */ (document.getElementById("btnGenBest"));
  const btnGenCopy = /** @type {HTMLButtonElement} */ (document.getElementById("btnGenCopy"));
  const genericList = /** @type {HTMLElement} */ (document.getElementById("genericList"));
  const btnGenericRefresh = /** @type {HTMLButtonElement} */ (document.getElementById("btnGenericRefresh"));
  const genSeasonSwitchWrap = /** @type {HTMLElement} */ (document.getElementById("genSeasonSwitchWrap"));
  const btnSwitchToSeason = /** @type {HTMLButtonElement} */ (document.getElementById("btnSwitchToSeason"));

  genPageTitle.textContent = cleanTabTitle;
  updateDestLine();

  async function renderGeneric(scanNow = false) {
    const res = await send({ action: "getCaptured", tabId: tab.id, scanNow });
    if (res && Array.isArray(res.langs)) {
      populateLanguageDropdowns(res.langs);
    }
    const items = (res && res.items) || [];
    const fmtLabel = (settings.exportFormat || "md").toUpperCase();
    const sig = `${fmtLabel}|` + items.map((t) => `${t.key}:${t.cueCount}:${t.segmentCount}`).join(";");
    if (!scanNow && sig === lastGenericSignature) return;
    lastGenericSignature = sig;

    if (!items.length) {
      genPill.textContent = "NO SUBTITLES DETECTED";
      genPill.style.color = "#f59e0b";
      if (genDestRow) genDestRow.style.display = "none";
      if (genPrimaryActions) genPrimaryActions.style.display = "none";
      genericList.innerHTML = `
        <div style="padding: 10px 4px; line-height: 1.5; color: var(--text-secondary); font-size: 13px;">
          <div style="font-weight: 600; color: #f59e0b; margin-bottom: 4px;">⚠️ No subtitles currently available</div>
          <div>No subtitle tracks were found on this video. Make sure Closed Captions (CC) or <strong>Audio &amp; Subtitles</strong> is turned on in the video player, then click the refresh button (↻) above to re-scan.</div>
        </div>
      `;
      return;
    }

    genPill.textContent =
      items.length === 1 ? "SUBTITLES AVAILABLE" : `SUBTITLES AVAILABLE · ${items.length} TRACKS`;
    genPill.style.color = "var(--success)";
    if (genDestRow) genDestRow.style.display = "flex";
    if (genPrimaryActions) genPrimaryActions.style.display = "flex";
    if (!btnGenBest.disabled) {
      btnGenBest.textContent = `Download Subtitle (.${fmtLabel})`;
    }

    const frag = document.createDocumentFragment();
    items.forEach((track, i) => {
      const row = document.createElement("div");
      row.className = "track-item";
      const fmtBadge = track.format || "SUB";
      const detailParts = [];
      if (track.lang) detailParts.push(track.lang.toUpperCase());
      if (track.cueCount > 0) detailParts.push(`${track.cueCount} cues`);
      else if (track.isHlsPlaylist && track.segmentCount > 0) detailParts.push(`${track.segmentCount} segments`);
      else detailParts.push("Ready");

      row.innerHTML = `
        <div class="track-meta">
          <div class="track-url" title="${track.url || track.label}">${track.label || `Subtitle Track ${i + 1}`}</div>
          <div class="track-sub">
            <span class="fmt-badge">${fmtBadge}</span>
            <span>${detailParts.join(" · ")}</span>
          </div>
        </div>
        <button class="small-btn">Save .${fmtLabel}</button>
      `;
      const saveBtn = /** @type {HTMLButtonElement | null} */ (row.querySelector(".small-btn"));
      if (saveBtn) {
        saveBtn.addEventListener("click", async (e) => {
          const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
          btn.textContent = "Saving...";
          btn.disabled = true;
          const r = await send({
            action: "saveGeneric",
            tabId: tab.id,
            key: track.key,
            url: track.url,
            prefix: stored[Config.STORAGE_KEYS.SEASON_PREFIX] || "Subtitles"
          });
          btn.disabled = false;
          btn.textContent = r && r.ok ? `✓ Saved (${r.cues})` : "Failed";
        });
      }
      frag.appendChild(row);
    });
    genericList.replaceChildren(frag);
  }

  btnGenBest.addEventListener("click", async () => {
    btnGenBest.disabled = true;
    btnGenBest.textContent = "Downloading Subtitle...";
    const r = await send({
      action: "saveGeneric",
      tabId: tab.id,
      key: "__BEST__",
      url: "__BEST__",
      prefix: stored[Config.STORAGE_KEYS.SEASON_PREFIX] || "Subtitles"
    });
    btnGenBest.disabled = false;
    const fmtLabel = (settings.exportFormat || "md").toUpperCase();
    btnGenBest.textContent = r && r.ok ? `✓ Saved (${r.cues} cues)` : `Failed: ${(r && r.error) || "retry"}`;
    setTimeout(() => {
      if (!btnGenBest.disabled) btnGenBest.textContent = `Download Subtitle (.${fmtLabel})`;
    }, 3000);
  });

  bindCopyButton(
    btnGenCopy,
    async () => {
      const r = await send({
        action: "saveGeneric",
        tabId: tab.id,
        key: "__BEST__",
        url: "__BEST__",
        prefix: stored[Config.STORAGE_KEYS.SEASON_PREFIX] || "Subtitles",
        copyOnly: true
      });
      return { ok: r?.ok, content: r?.content, count: r?.cues, error: r?.error };
    },
    "cues"
  );

  btnGenericRefresh.addEventListener("click", () => renderGeneric(true));

  if (btnSwitchToSeason) {
    btnSwitchToSeason.addEventListener("click", async () => {
      setViewMode("season");
      const st = await send({
        action: "getAutoPilotStatus",
        season: season(),
        showTitle: prefixInput.value.trim()
      });
      renderSeasonView(st);
      if (st && !st.enabled && !st.total && season()) {
        btnScan.click();
      }
    });
  }
  if (btnSwitchToGeneric) {
    btnSwitchToGeneric.addEventListener("click", async () => {
      setViewMode("generic");
      await renderGeneric(true);
    });
  }

  // ---------- Initialize Active View ----------
  if (activeMode === "playlist") {
    const st = await send({ action: "getPlaylistStatus", tabId: tab.id });
    if (!st || !st.enabled) {
      await scanPlaylist(true);
    } else {
      renderPlaylistView(st);
    }
  } else {
    const st0 = await send({ action: "getAutoPilotStatus" });
    const det = await send({ action: "detectSeason", tabId: tab.id });
    const detectedSeason =
      (st0 && st0.enabled && st0.tabId === tab.id && st0.season) || (det && det.season) || null;
    if (detectedSeason) {
      seasonInput.value = String(detectedSeason);
      if (genSeasonSwitchWrap) genSeasonSwitchWrap.style.display = "flex";
      updateDestLine();
    }
    if (btnSwitchToGeneric) {
      btnSwitchToGeneric.style.display = "inline-flex";
    }

    if (st0 && st0.enabled && st0.tabId === tab.id && st0.mode === "season") {
      setViewMode("season");
      await refreshSeason();
    } else if (activeMode === "season") {
      await refreshSeason();
      const curSt = await send({
        action: "getAutoPilotStatus",
        season: season(),
        showTitle: prefixInput.value.trim()
      });
      if (curSt && !curSt.enabled && !curSt.total && season()) {
        btnScan.click();
      }
    } else {
      await renderGeneric(true);
    }
  }

  setInterval(() => {
    if (settingsView.classList.contains("active")) return;
    if (activeMode === "playlist") refreshPlaylist();
    else if (activeMode === "season") refreshSeason();
    else renderGeneric(false);
  }, 1000);
});
