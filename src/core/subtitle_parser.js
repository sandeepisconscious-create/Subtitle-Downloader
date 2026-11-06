// @ts-check
/**
 * Universal Subtitle Parser, Cue Merger, HLS Stitcher & Output Formatter.
 * Supports:
 *  1. WebVTT (.vtt) & SubRip (.srt)
 *  2. TTML / DFXP / IMSC1 / EBU-TT / SMPTE-TT (.ttml, .dfxp, .xml) including tickRate (t), offset (s/ms), and frame timecodes
 *  3. TimedText XML (SRV1, SRV2, SRV3) & JSON3
 *  4. Advanced SubStation Alpha (.ass / .ssa)
 *  5. SAMI (.smi / .sami)
 *  6. Generic JSON Subtitle / Transcript schemas
 *  7. Fragmented MP4 (fMP4 / ISO BMFF) stpp (TTML-in-MP4) & wvtt/vttc (WebVTT-in-MP4)
 *  8. HLS (.m3u8) Master & Media Subtitle Playlists
 *  9. Output formatting to .md, .txt, .srt, .vtt
 */

(function (root) {
  const MAX_CUES = 20000;
  const SHARED_UTF8_DECODER = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;

  /** @type {Record<string, string>} */
  const NAMED_ENTITIES = Object.freeze({
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&nbsp;": " ",
    "&lrm;": "",
    "&rlm;": "",
    "&ndash;": "–",
    "&mdash;": "—",
    "&hellip;": "…"
  });

  const RE_NAMED_ENTITY = /&(?:amp|lt|gt|quot|apos|#39|nbsp|lrm|rlm|ndash|mdash|hellip);/gi;
  const RE_DEC_ENTITY = /&#(\d+);/g;
  const RE_HEX_ENTITY = /&#x([0-9a-fA-F]+);/g;
  const RE_BR_TAG = /<br\s*\/?>/gi;
  const RE_ASS_NEWLINE = /\\N|\\n|\\h/g;
  const RE_ASS_OVERRIDE = /\{[^}]*\}/g;
  const RE_HTML_TAG = /<[^>]+>/g;
  const RE_ZERO_WIDTH = /[\u200B-\u200F\uFEFF]/g;
  const RE_WHITESPACE = /\s+/g;

  /**
   * Format seconds as [HH:MM:SS] for Markdown/Text transcripts.
   * @param {number} sec
   * @returns {string}
   */
  function secToBracket(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `[${hh}:${mm}:${ss}]`;
  }

  /**
   * Format seconds as HH:MM:SS,mmm (SRT) or HH:MM:SS.mmm (VTT).
   * @param {number} sec
   * @param {"," | "."} [sep=","]
   * @returns {string}
   */
  function secToTimestamp(sec, sep = ",") {
    const totalMs = Math.max(0, Math.round((Number(sec) || 0) * 1000));
    const hh = String(Math.floor(totalMs / 3600000)).padStart(2, "0");
    const mm = String(Math.floor((totalMs % 3600000) / 60000)).padStart(2, "0");
    const ss = String(Math.floor((totalMs % 60000) / 1000)).padStart(2, "0");
    const ms = String(totalMs % 1000).padStart(3, "0");
    return `${hh}:${mm}:${ss}${sep}${ms}`;
  }

  /**
   * Decode HTML/XML entities (up to 2 passes for double-encoded strings).
   * Fast-paths strings without '&'.
   * @param {string} str
   * @returns {string}
   */
  function decodeHtmlEntities(str) {
    if (!str) return "";
    let s = String(str);
    if (!s.includes("&")) return s;
    for (let pass = 0; pass < 2; pass++) {
      if (!s.includes("&")) break;
      const prev = s;
      s = s
        .replace(RE_NAMED_ENTITY, (m) => NAMED_ENTITIES[m.toLowerCase()] ?? m)
        .replace(RE_DEC_ENTITY, (_, dec) => {
          const code = parseInt(dec, 10);
          return code > 0 ? String.fromCodePoint(code) : "";
        })
        .replace(RE_HEX_ENTITY, (_, hex) => {
          const code = parseInt(hex, 16);
          return code > 0 ? String.fromCodePoint(code) : "";
        });
      if (s === prev) break;
    }
    return s;
  }

  /**
   * Strip markup, ASS overrides, and directional control characters from a cue string.
   * @param {string} raw
   * @returns {string}
   */
  function cleanCueText(raw) {
    if (!raw) return "";
    let s = String(raw);
    if (s.includes("<") || s.includes("\\") || s.includes("{")) {
      s = s
        .replace(RE_BR_TAG, " ")
        .replace(RE_ASS_NEWLINE, " ")
        .replace(RE_ASS_OVERRIDE, "")
        .replace(RE_HTML_TAG, " ");
    }
    if (s.includes("&")) {
      s = decodeHtmlEntities(s);
    }
    return s.replace(RE_ZERO_WIDTH, "").replace(RE_WHITESPACE, " ").trim();
  }

  /**
   * Parse time expressions across VTT/SRT, TTML ticks/offsets, and SMPTE frames.
   * @param {string | number | null | undefined} expr
   * @param {number} [tickRate=10000000]
   * @param {number} [frameRate=30]
   * @returns {number | null}
   */
  function parseTimeExpr(expr, tickRate = 10000000, frameRate = 30) {
    if (expr === null || expr === undefined) return null;
    if (typeof expr === "number") return Number.isFinite(expr) ? expr : null;
    const s = String(expr).trim();
    if (!s) return null;

    const tickMatch = s.match(/^(\d+(?:\.\d+)?)t$/i);
    if (tickMatch) {
      return parseFloat(tickMatch[1]) / (tickRate || 10000000);
    }

    const offsetMatch = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|f)$/i);
    if (offsetMatch) {
      const val = parseFloat(offsetMatch[1]);
      const unit = offsetMatch[2].toLowerCase();
      if (unit === "ms") return val / 1000;
      if (unit === "s") return val;
      if (unit === "m") return val * 60;
      if (unit === "h") return val * 3600;
      if (unit === "f") return val / (frameRate || 30);
    }

    if (/^\d+(?:\.\d+)?$/.test(s)) {
      return parseFloat(s);
    }

    const clean = s.replace(",", ".");
    const parts = clean.split(":");
    if (parts.length === 4) {
      return (
        (parseFloat(parts[0]) || 0) * 3600 +
        (parseFloat(parts[1]) || 0) * 60 +
        (parseFloat(parts[2]) || 0) +
        (parseFloat(parts[3]) || 0) / (frameRate || 30)
      );
    }
    if (parts.length === 3) {
      return (
        (parseFloat(parts[0]) || 0) * 3600 +
        (parseFloat(parts[1]) || 0) * 60 +
        (parseFloat(parts[2]) || 0)
      );
    }
    if (parts.length === 2) {
      return (parseFloat(parts[0]) || 0) * 60 + (parseFloat(parts[1]) || 0);
    }
    return null;
  }

  /**
   * Sort cues chronologically, normalize start/end bounds, and merge overlapping duplicates.
   * @param {Array<{ startSec?: number, endSec?: number, text?: string }>} rawCues
   * @returns {Array<{ startSec: number, endSec: number, ts: string, text: string }>}
   */
  function normalizeAndDedupeCues(rawCues) {
    if (!Array.isArray(rawCues) || !rawCues.length) return [];
    const valid = [];
    for (const c of rawCues) {
      const text = cleanCueText(c.text || "");
      if (!text) continue;
      const startSec = Math.max(0, Number(c.startSec) || 0);
      let endSec = Number(c.endSec);
      if (!Number.isFinite(endSec) || endSec <= startSec) {
        endSec = startSec + 2.5;
      }
      valid.push({
        startSec,
        endSec,
        ts: secToBracket(startSec),
        text
      });
    }

    valid.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

    const out = [];
    for (const c of valid) {
      const prev = out[out.length - 1];
      if (prev && prev.text === c.text && Math.abs(c.startSec - prev.startSec) < 15) {
        if (c.endSec > prev.endSec) prev.endSec = c.endSec;
        continue;
      }
      out.push(c);
      if (out.length >= MAX_CUES) break;
    }
    return out;
  }

  // 1. Parse WebVTT (.vtt) and SubRip (.srt)
  function parseVttOrSrt(text) {
    const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
    const rawCues = [];

    let inHeaderBlock = false;
    /** @type {number | null} */
    let curStart = null;
    /** @type {number | null} */
    let curEnd = null;
    /** @type {string[]} */
    let curLines = [];

    const flushCue = () => {
      if (curStart !== null && curLines.length > 0) {
        const joined = cleanCueText(curLines.join(" "));
        if (joined) {
          rawCues.push({
            startSec: curStart,
            endSec: curEnd !== null ? curEnd : curStart + 2.5,
            text: joined
          });
        }
      }
      curStart = null;
      curEnd = null;
      curLines = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line) {
        inHeaderBlock = false;
        flushCue();
        continue;
      }
      if (/^(STYLE|NOTE|REGION)\b/i.test(line)) {
        flushCue();
        inHeaderBlock = true;
        continue;
      }
      if (inHeaderBlock) continue;
      if (/^(WEBVTT|Kind:|Language:|X-TIMESTAMP-MAP)/i.test(line)) continue;

      if (line.includes("-->")) {
        flushCue();
        const arrowParts = line.split("-->");
        const lhs = (arrowParts[0] || "").trim().split(/\s+/)[0];
        const rhs = (arrowParts[1] || "").trim().split(/\s+/)[0];
        const st = parseTimeExpr(lhs);
        const en = parseTimeExpr(rhs);
        if (st !== null) {
          curStart = st;
          curEnd = en !== null && en > st ? en : st + 2.5;
        }
        continue;
      }

      if (curStart === null && /^\d+$/.test(line)) continue;
      if (curStart !== null) curLines.push(line);
    }
    flushCue();

    return normalizeAndDedupeCues(rawCues);
  }

  // 2. Parse TTML / DFXP / IMSC1 / EBU-TT / SMPTE-TT & TimedText XML (SRV1/2/3)
  function parseXmlSubtitles(xmlText) {
    const str = String(xmlText || "").trim();
    if (!str) return [];

    const tickRateMatch = str.match(/\btickRate\s*=\s*["'](\d+)["']/i);
    const tickRate = tickRateMatch ? parseInt(tickRateMatch[1], 10) : 10000000;
    const frameRateMatch = str.match(/\bframeRate\s*=\s*["'](\d+(?:\.\d+)?)["']/i);
    const frameRate = frameRateMatch ? parseFloat(frameRateMatch[1]) : 30;

    const rawCues = [];

    // Try DOMParser first if available and if Trusted Types are supported or satisfied
    if (typeof DOMParser !== "undefined") {
      try {
        let xmlInput = str;
        if (typeof window !== "undefined" && window.trustedTypes && window.trustedTypes.createPolicy) {
          try {
            if (!window.__subTrustedXmlPolicy) {
              window.__subTrustedXmlPolicy = window.trustedTypes.createPolicy("sub-downloader-xml", {
                createHTML: (s) => s,
                createScript: (s) => s
              });
            }
            if (window.__subTrustedXmlPolicy) {
              xmlInput = window.__subTrustedXmlPolicy.createHTML(str);
            }
          } catch (_) {}
        }
        const doc = new DOMParser().parseFromString(xmlInput, "text/xml");
        const textNodes = doc.getElementsByTagName("text");
        if (textNodes && textNodes.length > 0) {
          for (let i = 0; i < textNodes.length; i++) {
            const node = textNodes[i];
            const start = parseTimeExpr(node.getAttribute("start"), tickRate, frameRate) ?? 0;
            const dur =
              parseTimeExpr(node.getAttribute("dur") || node.getAttribute("d"), tickRate, frameRate) ?? 2.5;
            const text = cleanCueText(node.textContent || "");
            if (text) rawCues.push({ startSec: start, endSec: start + dur, text });
          }
          if (rawCues.length > 0) return normalizeAndDedupeCues(rawCues);
        }

        const allNodes = doc.getElementsByTagName("*");
        for (let i = 0; i < allNodes.length; i++) {
          const node = allNodes[i];
          const local = (node.localName || node.tagName || "").toLowerCase().replace(/^.*:/, "");
          if (local !== "p") continue;

          const tMs = node.getAttribute("t");
          if (tMs !== null && tMs !== "") {
            const startSec = parseFloat(tMs) / 1000;
            const durSec = parseFloat(node.getAttribute("d") || "2500") / 1000;
            const text = cleanCueText(node.textContent || "");
            if (text) rawCues.push({ startSec, endSec: startSec + durSec, text });
            continue;
          }

          const beginAttr =
            node.getAttribute("begin") || node.getAttribute("tt:begin") || node.getAttribute("start");
          if (beginAttr !== null && beginAttr !== "") {
            const startSec = parseTimeExpr(beginAttr, tickRate, frameRate);
            if (startSec === null) continue;
            const endAttr = node.getAttribute("end") || node.getAttribute("tt:end");
            const durAttr = node.getAttribute("dur") || node.getAttribute("tt:dur");
            let endSec = endAttr ? parseTimeExpr(endAttr, tickRate, frameRate) : null;
            if (endSec === null && durAttr) {
              const d = parseTimeExpr(durAttr, tickRate, frameRate);
              if (d !== null) endSec = startSec + d;
            }
            const text = cleanCueText(node.textContent || "");
            if (text) rawCues.push({ startSec, endSec: endSec ?? startSec + 2.5, text });
          }
        }
        if (rawCues.length > 0) return normalizeAndDedupeCues(rawCues);
      } catch (_) {
        // Fall through to regex parser on any Trusted Types or DOMParser security restriction
      }
    }

    // Service-worker-compatible regex fallback
    const textTagRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let m;
    while ((m = textTagRe.exec(str)) !== null) {
      const attrs = m[1];
      const body = m[2];
      const stM = attrs.match(/\bstart\s*=\s*["']([^"']+)["']/i);
      const durM = attrs.match(/\bdur\s*=\s*["']([^"']+)["']/i);
      const startSec = stM ? parseTimeExpr(stM[1], tickRate, frameRate) ?? 0 : 0;
      const durSec = durM ? parseTimeExpr(durM[1], tickRate, frameRate) ?? 2.5 : 2.5;
      const text = cleanCueText(body);
      if (text) rawCues.push({ startSec, endSec: startSec + durSec, text });
    }
    if (rawCues.length > 0) return normalizeAndDedupeCues(rawCues);

    const pTagRe = /<(?:[a-zA-Z0-9_]+:)?p\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?p>/gi;
    while ((m = pTagRe.exec(str)) !== null) {
      const attrs = m[1];
      const body = m[2];

      const tM = attrs.match(/\bt\s*=\s*["'](\d+(?:\.\d+)?)["']/i);
      if (tM) {
        const startSec = parseFloat(tM[1]) / 1000;
        const dM = attrs.match(/\bd\s*=\s*["'](\d+(?:\.\d+)?)["']/i);
        const durSec = dM ? parseFloat(dM[1]) / 1000 : 2.5;
        const text = cleanCueText(body);
        if (text) rawCues.push({ startSec, endSec: startSec + durSec, text });
        continue;
      }

      const beginM = attrs.match(/\b(?:[a-zA-Z0-9_]+:)?(?:begin|start)\s*=\s*["']([^"']+)["']/i);
      if (beginM) {
        const startSec = parseTimeExpr(beginM[1], tickRate, frameRate);
        if (startSec === null) continue;
        const endM = attrs.match(/\b(?:[a-zA-Z0-9_]+:)?end\s*=\s*["']([^"']+)["']/i);
        const durM = attrs.match(/\b(?:[a-zA-Z0-9_]+:)?dur\s*=\s*["']([^"']+)["']/i);
        let endSec = endM ? parseTimeExpr(endM[1], tickRate, frameRate) : null;
        if (endSec === null && durM) {
          const d = parseTimeExpr(durM[1], tickRate, frameRate);
          if (d !== null) endSec = startSec + d;
        }
        const text = cleanCueText(body);
        if (text) rawCues.push({ startSec, endSec: endSec ?? startSec + 2.5, text });
      }
    }

    return normalizeAndDedupeCues(rawCues);
  }

  // 3. Parse SubStation Alpha (.ass / .ssa)
  function parseAssOrSsa(text) {
    const lines = String(text || "").split(/\r?\n/);
    let inEvents = false;
    let startIdx = 1;
    let endIdx = 2;
    let textIdx = 9;
    let fieldCount = 10;
    const rawCues = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(";")) continue;
      if (/^\[Events\]/i.test(line)) {
        inEvents = true;
        continue;
      }
      if (/^\[.*\]$/.test(line)) {
        inEvents = false;
        continue;
      }
      if (!inEvents) continue;

      if (/^Format\s*:/i.test(line)) {
        const cols = line
          .replace(/^Format\s*:/i, "")
          .split(",")
          .map((c) => c.trim().toLowerCase());
        fieldCount = cols.length;
        const sI = cols.indexOf("start");
        const eI = cols.indexOf("end");
        const tI = cols.indexOf("text");
        if (sI >= 0) startIdx = sI;
        if (eI >= 0) endIdx = eI;
        if (tI >= 0) textIdx = tI;
        continue;
      }

      if (/^Dialogue\s*:/i.test(line)) {
        const payload = line.replace(/^Dialogue\s*:\s*/i, "");
        const parts = [];
        let cur = "";
        let commas = 0;
        for (let i = 0; i < payload.length; i++) {
          const ch = payload[i];
          if (ch === "," && commas < fieldCount - 1) {
            parts.push(cur);
            cur = "";
            commas++;
          } else {
            cur += ch;
          }
        }
        parts.push(cur);

        const st = parseTimeExpr(parts[startIdx]);
        const en = parseTimeExpr(parts[endIdx]);
        const rawTxt = parts[textIdx] || "";
        if (/\{\\p[1-9]/.test(rawTxt)) continue;
        const clean = cleanCueText(rawTxt);
        if (st !== null && clean) {
          rawCues.push({ startSec: st, endSec: en ?? st + 2.5, text: clean });
        }
      }
    }
    return normalizeAndDedupeCues(rawCues);
  }

  // 4. Parse SAMI (.smi / .sami)
  function parseSami(text) {
    const str = String(text || "");
    const rawCues = [];
    const syncRe = /<SYNC\b[^>]*\bStart\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<SYNC\b|<\/BODY|$)/gi;
    let m;
    while ((m = syncRe.exec(str)) !== null) {
      const startSec = parseInt(m[1], 10) / 1000;
      const clean = cleanCueText(m[2]);
      if (clean) rawCues.push({ startSec, endSec: startSec + 2.5, text: clean });
    }
    for (let i = 0; i < rawCues.length - 1; i++) {
      if (rawCues[i + 1].startSec > rawCues[i].startSec) {
        rawCues[i].endSec = Math.min(rawCues[i].startSec + 6, rawCues[i + 1].startSec);
      }
    }
    return normalizeAndDedupeCues(rawCues);
  }

  // 5. Parse JSON Subtitle / TimedText Formats
  function parseJsonSubtitles(input) {
    let data = input;
    if (typeof input === "string") {
      try {
        data = JSON.parse(input);
      } catch (_) {
        return [];
      }
    }
    if (!data || typeof data !== "object") return [];

    const rawCues = [];

    if (Array.isArray(data.events)) {
      for (const ev of data.events) {
        if (!ev) continue;
        const startMs = ev.tStartMs ?? ev.start ?? ev.startTime;
        const durMs = ev.dDurationMs ?? ev.duration ?? 2500;
        let txt = "";
        if (Array.isArray(ev.segs)) {
          txt = ev.segs.map((s) => (s && s.utf8) || "").join("");
        } else if (typeof ev.text === "string") {
          txt = ev.text;
        }
        const clean = cleanCueText(txt);
        if (clean && startMs !== undefined) {
          const startSec = Number(startMs) / 1000;
          rawCues.push({ startSec, endSec: startSec + Number(durMs) / 1000, text: clean });
        }
      }
      if (rawCues.length > 0) return normalizeAndDedupeCues(rawCues);
    }

    const candidateArrays = [];
    if (Array.isArray(data)) {
      candidateArrays.push(data);
    } else {
      const arrayKeys = [
        "subtitles",
        "captions",
        "cues",
        "body",
        "lines",
        "segments",
        "transcript",
        "items",
        "data",
        "results"
      ];
      for (const k of arrayKeys) {
        if (Array.isArray(data[k])) candidateArrays.push(data[k]);
        else if (data[k] && typeof data[k] === "object") {
          for (const subK of arrayKeys) {
            if (Array.isArray(data[k][subK])) candidateArrays.push(data[k][subK]);
          }
        }
      }
    }

    for (const arr of candidateArrays) {
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const rawText =
          item.text ??
          item.content ??
          item.utf8 ??
          item.body ??
          item.line ??
          item.value ??
          item.caption ??
          item.subtitle;
        if (typeof rawText !== "string") continue;

        let startSec = null;
        let endSec = null;

        if (item.start_ms !== undefined || item.startMs !== undefined || item.tStartMs !== undefined) {
          startSec = Number(item.start_ms ?? item.startMs ?? item.tStartMs) / 1000;
        } else if (
          item.start !== undefined ||
          item.startTime !== undefined ||
          item.from !== undefined ||
          item.begin !== undefined ||
          item.offset !== undefined ||
          item.time !== undefined
        ) {
          startSec = parseTimeExpr(
            item.start ?? item.startTime ?? item.from ?? item.begin ?? item.offset ?? item.time
          );
        }

        if (item.end_ms !== undefined || item.endMs !== undefined) {
          endSec = Number(item.end_ms ?? item.endMs) / 1000;
        } else if (item.end !== undefined || item.endTime !== undefined || item.to !== undefined) {
          endSec = parseTimeExpr(item.end ?? item.endTime ?? item.to);
        } else if (item.duration_ms !== undefined || item.dDurationMs !== undefined) {
          endSec = (startSec ?? 0) + Number(item.duration_ms ?? item.dDurationMs) / 1000;
        } else if (item.duration !== undefined || item.dur !== undefined) {
          const d = parseTimeExpr(item.duration ?? item.dur);
          if (d !== null) endSec = (startSec ?? 0) + d;
        }

        const clean = cleanCueText(rawText);
        if (clean && startSec !== null) {
          rawCues.push({ startSec, endSec: endSec ?? startSec + 2.5, text: clean });
        }
      }
      if (rawCues.length > 0) return normalizeAndDedupeCues(rawCues);
    }

    return [];
  }

  // 6. Parse Binary fMP4 (ISO BMFF) Subtitle Segments (stpp TTML-in-MP4 & wvtt/vttc WebVTT-in-MP4)
  function parseFmp4Subtitles(arrayBuffer) {
    if (!arrayBuffer || !(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 16) {
      return [];
    }
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const decoder = SHARED_UTF8_DECODER || new TextDecoder("utf-8", { fatal: false });
    const fullText = decoder.decode(bytes);

    const ttStart = fullText.search(/<(?:\?xml|[a-zA-Z0-9_]*:?tt\b)/);
    if (ttStart >= 0) {
      const ttEndMatch = fullText.match(/<\/(?:[a-zA-Z0-9_]+:)?tt\s*>/);
      const xmlSlice =
        ttEndMatch && ttEndMatch.index !== undefined
          ? fullText.slice(ttStart, ttEndMatch.index + ttEndMatch[0].length)
          : fullText.slice(ttStart);
      const xmlCues = parseXmlSubtitles(xmlSlice);
      if (xmlCues.length > 0) return xmlCues;
    }

    let timescale = 1000;
    let baseTime = 0;
    const rawCues = [];

    const readBoxType = (offset) => {
      if (offset + 8 > bytes.length) return null;
      return String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7]
      );
    };

    const walkBoxes = (start, end) => {
      let ptr = start;
      while (ptr + 8 <= end) {
        let size = view.getUint32(ptr);
        const type = readBoxType(ptr);
        let headerSize = 8;
        if (size === 1 && ptr + 16 <= end) {
          size = Number(view.getBigUint64(ptr + 8));
          headerSize = 16;
        } else if (size === 0) {
          size = end - ptr;
        }
        if (size < headerSize || ptr + size > end) break;

        const payloadStart = ptr + headerSize;
        const boxEnd = ptr + size;

        if (type === "moov" || type === "trak" || type === "mdia" || type === "moof" || type === "traf" || type === "mdat") {
          walkBoxes(payloadStart, boxEnd);
        } else if (type === "mdhd" && payloadStart + 20 <= boxEnd) {
          const version = bytes[payloadStart];
          timescale = view.getUint32(payloadStart + (version === 1 ? 20 : 12)) || 1000;
        } else if (type === "tfdt" && payloadStart + 8 <= boxEnd) {
          const version = bytes[payloadStart];
          baseTime =
            version === 1 && payloadStart + 12 <= boxEnd
              ? Number(view.getBigUint64(payloadStart + 4))
              : view.getUint32(payloadStart + 4);
        } else if (type === "vttc") {
          let vPtr = payloadStart;
          while (vPtr + 8 <= boxEnd) {
            const subSize = view.getUint32(vPtr);
            const subType = readBoxType(vPtr);
            if (subSize < 8 || vPtr + subSize > boxEnd) break;
            if (subType === "payl") {
              const txt = cleanCueText(decoder.decode(bytes.subarray(vPtr + 8, vPtr + subSize)));
              if (txt) {
                const startSec = timescale > 0 ? baseTime / timescale : 0;
                rawCues.push({ startSec, endSec: startSec + 2.5, text: txt });
              }
            }
            vPtr += subSize;
          }
        }
        ptr = boxEnd;
      }
    };

    try {
      walkBoxes(0, bytes.length);
    } catch (_) {}

    return normalizeAndDedupeCues(rawCues);
  }

  // 7. Inspect HLS (.m3u8) Master or Subtitle Media Playlist
  function inspectM3u8Manifest(text, baseUrl) {
    const str = String(text || "").trim();
    if (!str.startsWith("#EXTM3U")) return null;

    const resolveUrl = (rel) => {
      try {
        return new URL(rel, baseUrl).href;
      } catch (_) {
        return rel;
      }
    };

    const lines = str
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const subtitleTracks = [];
    for (const line of lines) {
      if (/^#EXT-X-MEDIA:.*TYPE=SUBTITLES/i.test(line)) {
        const uriM = line.match(/URI="([^"]+)"/i);
        if (!uriM || /FORCED=YES/i.test(line)) continue;
        const langM = line.match(/LANGUAGE="([^"]+)"/i);
        const nameM = line.match(/NAME="([^"]+)"/i);
        subtitleTracks.push({
          url: resolveUrl(uriM[1]),
          lang: langM ? langM[1] : "und",
          label: nameM ? nameM[1] : langM ? langM[1] : "Subtitle Track"
        });
      }
    }
    if (subtitleTracks.length > 0) {
      return { type: "master", subtitleTracks };
    }

    // Ignore encrypted media playlists or video master streams without subtitle declarations
    if (/#EXT-X-KEY:.*METHOD=(?!NONE)/i.test(str) || /#EXT-X-STREAM-INF:/i.test(str)) {
      return null;
    }

    const segments = [];
    let isSubtitleMedia = false;
    for (const line of lines) {
      if (line.startsWith("#")) {
        if (/^#EXT-X-MAP:/i.test(line)) {
          const mapM = line.match(/URI="([^"]+)"/i);
          if (mapM && /\.(vtt|webvtt|ttml|dfxp)(\?|$|#)/i.test(mapM[1])) isSubtitleMedia = true;
        }
        continue;
      }
      const fullSegUrl = resolveUrl(line);
      const pathOnly = fullSegUrl.split("?")[0].split("#")[0];
      if (
        /\.(vtt|webvtt|srt|ttml|dfxp)(\?|$|#)/i.test(fullSegUrl) ||
        /\b(subtitles?|captions?|texttracks?|webvtt|wvtt|stpp)\b/i.test(pathOnly)
      ) {
        isSubtitleMedia = true;
      }
      segments.push(fullSegUrl);
    }

    if (isSubtitleMedia && segments.length > 0) {
      return { type: "media", segments };
    }
    return null;
  }

  // 8. Master Universal Entrypoint
  function parseUniversalSubtitle(payload, hintUrl = "") {
    if (!payload) return { format: null, cues: [] };

    if (payload instanceof ArrayBuffer) {
      const fmp4Cues = parseFmp4Subtitles(payload);
      if (fmp4Cues.length > 0) return { format: "FMP4", cues: fmp4Cues };
      const decoder = SHARED_UTF8_DECODER || new TextDecoder("utf-8", { fatal: false });
      const decoded = decoder.decode(new Uint8Array(payload));
      return parseUniversalSubtitle(decoded, hintUrl);
    }

    if (typeof payload === "object") {
      const jsonCues = parseJsonSubtitles(payload);
      return { format: jsonCues.length ? "JSON" : null, cues: jsonCues };
    }

    const str = String(payload || "").replace(/^\uFEFF/, "").trim();
    if (!str) return { format: null, cues: [] };

    if (/^WEBVTT\b/i.test(str) || /\.(vtt|webvtt)(\?|$)/i.test(hintUrl)) {
      const cues = parseVttOrSrt(str);
      if (cues.length > 0) return { format: "VTT", cues };
    }
    if (/\[Script Info\]|\[Events\]|\bDialogue\s*:\s*\d+,/i.test(str) || /\.(ass|ssa)(\?|$)/i.test(hintUrl)) {
      const cues = parseAssOrSsa(str);
      if (cues.length > 0) return { format: "ASS", cues };
    }
    if (
      str.startsWith("<?xml") ||
      /^<(?:[a-zA-Z0-9_]+:)?(?:tt|timedtext|transcript)\b/i.test(str) ||
      /<(?:[a-zA-Z0-9_]+:)?p\b[^>]*\b(?:begin|t)\s*=/i.test(str) ||
      /<text\b[^>]*\bstart\s*=/i.test(str)
    ) {
      const cues = parseXmlSubtitles(str);
      if (cues.length > 0) return { format: "TTML", cues };
    }
    if (/<SAMI\b|<SYNC\b[^>]*\bStart=/i.test(str)) {
      const cues = parseSami(str);
      if (cues.length > 0) return { format: "SAMI", cues };
    }
    if ((str.startsWith("{") && str.endsWith("}")) || (str.startsWith("[") && str.endsWith("]"))) {
      const cues = parseJsonSubtitles(str);
      if (cues.length > 0) return { format: "JSON", cues };
    }
    if (str.includes("-->")) {
      const cues = parseVttOrSrt(str);
      if (cues.length > 0) return { format: "SRT", cues };
    }

    return { format: null, cues: [] };
  }

  /**
   * Shared HLS Segment Stitcher used in both Page Context and Service Worker.
   * @param {string[]} segments
   * @param {typeof fetch} fetchFn
   * @param {RequestCredentials} [credentials="include"]
   * @returns {Promise<{ ok: boolean, format: string, cues: Array<{startSec: number, endSec: number, ts: string, text: string}>, error: string | null }>}
   */
  async function stitchHlsSegments(segments, fetchFn = fetch, credentials = "include") {
    const allCues = [];
    const maxSegs = Math.min(segments.length, 400);
    const batchSize = 16;

    for (let i = 0; i < maxSegs; i += batchSize) {
      const batch = segments.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (segUrl) => {
          try {
            const resp = await fetchFn(segUrl, { credentials });
            if (!resp.ok) return [];
            const ct = (resp.headers && resp.headers.get("content-type")) || "";
            if (/\.(m4s|mp4|dash|cmft)(\?|$)/i.test(segUrl) || /octet-stream|mp4/i.test(ct)) {
              const buf = await resp.arrayBuffer();
              return parseUniversalSubtitle(buf, segUrl).cues;
            }
            const txt = await resp.text();
            return parseUniversalSubtitle(txt, segUrl).cues;
          } catch (_) {
            return [];
          }
        })
      );
      for (const cues of results) {
        if (cues && cues.length) allCues.push(...cues);
      }
    }

    const merged = normalizeAndDedupeCues(allCues);
    return {
      ok: merged.length > 0,
      format: "HLS",
      cues: merged,
      error: merged.length ? null : "Could not parse cues from HLS segments"
    };
  }

  /**
   * Group timestamp-free cues into readable paragraphs based on speaker pauses and sentence endings.
   * @param {Array<{ startSec: number, endSec: number, text: string }>} cues
   * @returns {string[]}
   */
  function groupCuesIntoParagraphs(cues) {
    const paragraphs = [];
    /** @type {string[]} */
    let current = [];
    let prevEnd = 0;

    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const text = (c.text || "").trim();
      if (!text) continue;

      const gap = i > 0 ? Math.max(0, (c.startSec || 0) - prevEnd) : 0;
      if (current.length > 0 && gap >= 2.2) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      current.push(text);
      prevEnd = c.endSec || (c.startSec || 0) + 2;

      const endsSentence = /[.?!।॥…]["')\]}]*$/.test(text);
      if ((endsSentence && current.length >= 3) || current.length >= 6) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    }
    if (current.length > 0) {
      paragraphs.push(current.join(" "));
    }
    return paragraphs;
  }

  /**
   * Format normalized cues into the user's selected output format (.md, .txt, .srt, .vtt).
   * @param {Array<{ startSec: number, endSec: number, ts?: string, text: string }>} cues
   * @param {{ heading?: string, sublines?: string[] }} [meta={}]
   * @param {{ exportFormat?: string, includeTimestamps?: boolean, includeHeader?: boolean, stripSoundTags?: boolean }} [settings={}]
   * @returns {string}
   */
  function formatCuesOutput(cues, meta = {}, settings = {}) {
    const fmt = String(settings.exportFormat || "md").toLowerCase();
    const includeTs = settings.includeTimestamps !== false;
    const includeHdr = settings.includeHeader !== false;
    const stripSounds = !!settings.stripSoundTags;

    const filteredCues = stripSounds
      ? cues
          .map((c) => ({
            ...c,
            text: String(c.text || "")
              .replace(/\[[^\]]*\]|\([^)]*(?:music|applause|laughter|audio|sound|singing|आवाज़|संगीत)[^)]*\)|[♪♫]+/gi, " ")
              .replace(/\s+/g, " ")
              .trim()
          }))
          .filter((c) => c.text.length > 0)
      : cues;

    if (fmt === "srt") {
      return filteredCues
        .map((c, idx) => {
          const st = secToTimestamp(c.startSec ?? 0, ",");
          const en = secToTimestamp(c.endSec ?? (c.startSec ?? 0) + 2.5, ",");
          return `${idx + 1}\n${st} --> ${en}\n${c.text}\n`;
        })
        .join("\n");
    }

    if (fmt === "vtt") {
      const blocks = filteredCues.map((c) => {
        const st = secToTimestamp(c.startSec ?? 0, ".");
        const en = secToTimestamp(c.endSec ?? (c.startSec ?? 0) + 2.5, ".");
        return `${st} --> ${en}\n${c.text}\n`;
      });
      return `WEBVTT\n\n` + blocks.join("\n");
    }

    if (fmt === "txt") {
      const head = [];
      if (includeHdr) {
        if (meta.heading) head.push(meta.heading, "");
        if (meta.sublines && meta.sublines.length) {
          meta.sublines.forEach((l) => head.push(l.replace(/\*\*/g, "")));
        }
        head.push("", "----------------------------------------", "");
      }
      const body = includeTs
        ? filteredCues.map((c) => `${c.ts || secToBracket(c.startSec)} ${c.text}`)
        : groupCuesIntoParagraphs(filteredCues);
      return (head.length ? head.join("\n") + "\n" : "") + body.join(includeTs ? "\n" : "\n\n") + "\n";
    }

    // Default: Markdown ("md")
    const head = [];
    if (includeHdr) {
      if (meta.heading) head.push(`# ${meta.heading}`, "");
      if (meta.sublines && meta.sublines.length) {
        meta.sublines.forEach((l) => head.push(l));
      }
      head.push("", "---", "");
    }
    const body = includeTs
      ? filteredCues.map((c) => `${c.ts || secToBracket(c.startSec)} ${c.text}\n`)
      : groupCuesIntoParagraphs(filteredCues).map((p) => `${p}\n`);
    return (head.length ? head.join("\n") + "\n" : "") + body.join("\n");
  }

  /**
   * Build a properly typed UTF-8 data URL so Chromium's DownloadTargetDeterminer
   * never overrides .md, .srt, or .vtt extensions to .txt.
   * @param {string} content
   * @param {string} [format="md"]
   * @returns {string}
   */
  function toSubtitleDataUrl(content, format = "md") {
    const fmt = String(format || "md").toLowerCase();
    /** @type {Record<string, string>} */
    const mimeByFormat = {
      md: "text/markdown",
      srt: "application/x-subrip",
      vtt: "text/vtt",
      txt: "text/plain"
    };
    const mime = mimeByFormat[fmt] || "application/octet-stream";
    return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  }

  /**
   * Generate a standardized Markdown batch download summary report.
   * @param {{
   *   heading: string,
   *   totalLabel: string,
   *   totalCount: number,
   *   savedCount: number,
   *   missingIds: Array<string | number>,
   *   idHeader: string,
   *   countHeader: string,
   *   rows: Array<{ id: string | number, title: string, ok: boolean, size?: number, count?: number, note?: string, error?: string }>
   * }} opts
   * @returns {string}
   */
  function buildDownloadReport(opts) {
    const lines = [
      `# ${opts.heading}`,
      ``,
      `- **${opts.totalLabel}:** ${opts.totalCount}`,
      `- **Saved & verified:** ${opts.savedCount}`,
      `- **Missing:** ${opts.missingIds.length ? opts.missingIds.join(", ") : "none"}`,
      ``,
      `| ${opts.idHeader} | Title | Status | Size | ${opts.countHeader} | Note |`,
      `|---|---|---|---|---|---|`,
      ...opts.rows.map((r) => {
        const safeTitle = String(r.title || "").replace(/\|/g, "/");
        return r.ok
          ? `| ${r.id} | ${safeTitle} | saved | ${Math.round((r.size || 0) / 1024)} KB | ${r.count || 0} | ${r.note || ""} |`
          : `| ${r.id} | ${safeTitle} | missing | - | - | ${r.error || "not attempted"} |`;
      }),
      ``
    ];
    return lines.join("\n");
  }

  root.UniversalSubtitleParser = Object.freeze({
    secToBracket,
    secToTimestamp,
    cleanCueText,
    parseTimeExpr,
    normalizeAndDedupeCues,
    parseVttOrSrt,
    parseXmlSubtitles,
    parseAssOrSsa,
    parseSami,
    parseJsonSubtitles,
    parseFmp4Subtitles,
    inspectM3u8Manifest,
    parseUniversalSubtitle,
    stitchHlsSegments,
    formatCuesOutput,
    toSubtitleDataUrl,
    buildDownloadReport
  });
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
