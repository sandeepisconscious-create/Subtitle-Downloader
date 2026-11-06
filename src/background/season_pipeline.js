// @ts-check
/**
 * Episodic Season Scanner & Auto-Pilot Batch Downloader Pipeline.
 */

(function (root) {
  const Config = root.SubConfig;
  const Parser = root.UniversalSubtitleParser;
  const Hud = root.SubHud;
  const Registry = root.SubTrackRegistry;

  /**
   * Detect active season number from visible season selector pills/tabs, URL, or episode cards.
   * @param {number} tabId
   * @returns {Promise<number | null>}
   */
  function detectActiveSeason(tabId) {
    return Hud.inject(tabId, () => {
      // 1. Check URL first (e.g. /season-1, /season/1, ?season=1, /s1, season-17s)
      const href = window.location.href || "";
      const urlSeasonMatch = href.match(/(?:[?&]season=|\/season[-_/]?|\/s|[-_]season[-_]?)(\d+)/i);
      if (urlSeasonMatch) {
        const n = parseInt(urlSeasonMatch[1], 10);
        if (n > 0) return n;
      }

      // 2. Check visible episode cards rendered on screen (e.g. "S1 E1", "Season 1 Ep 1")
      const epCards = [...document.querySelectorAll("h1,h2,h3,h4,h5,div,span,p,a")].filter((e) => {
        if (e.children.length > 3) return false;
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      });
      for (const el of epCards) {
        const text = ((/** @type {HTMLElement} */ (el).innerText || "").split("\n")[0] || "").trim();
        const m = text.match(/\b(?:S|Season)\s*(\d+)\s*(?:E|Ep\.?|Episode)\s*\d+\b/i);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > 0) return n;
        }
      }

      // 3. Check active season pill / tab or drawer title
      const pills = [...document.querySelectorAll("button,[role=tab],a,div,span,option")].filter(
        (e) =>
          e.children.length <= 2 &&
          /^(?:Season|S)\s*\d+(?:\s+\d+\s*eps?)?$/i.test((/** @type {HTMLElement} */ (e).innerText || "").trim()) &&
          e.getBoundingClientRect().width > 0
      );
      if (pills.length) {
        const activePill = pills.find((e) => {
          if (e.getAttribute("aria-selected") === "true") return true;
          if (e.getAttribute("aria-current") === "true") return true;
          if (/** @type {HTMLOptionElement} */ (e).selected) return true;
          const cls =
            (e.className || "") + " " + ((e.parentElement && e.parentElement.className) || "");
          return /\b(?:active|selected|current|is-active|highlight)\b/i.test(cls);
        });
        if (activePill) {
          const m = (/** @type {HTMLElement} */ (activePill).innerText || "").match(/\d+/);
          if (m) return parseInt(m[0], 10);
        }
      }

      // 4. Check document title or heading (e.g. "Season 1")
      const titleMatch = (document.title || "").match(/\b(?:Season|S)\s*(\d+)\b/i);
      if (titleMatch) {
        const n = parseInt(titleMatch[1], 10);
        if (n > 0) return n;
      }

      // 5. Default to the first season pill in the list
      if (pills.length) {
        const m = (/** @type {HTMLElement} */ (pills[0]).innerText || "").match(/\d+/);
        if (m) return parseInt(m[0], 10);
      }
      return 1;
    });
  }

  /**
   * Expand and scan the episode list on a series page.
   * Handles virtualized DOM rendering, cumulative harvesting, and order detection (Ascending / Descending).
   * @param {number} tabId
   * @param {(msg: string) => void} setStatus
   * @param {any} [S=null]
   */
  async function buildEpisodeMap(tabId, setStatus, S = null) {
    setStatus("Reading episode list...");
    const scanInFrame = async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const visible = (el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };

      const CANDIDATE_SEL =
        "h1,h2,h3,h4,h5,h6,div,span,p,a,button,li,small,strong,b,em,label,article,section";

      const queryAllDeep = (selector, rootNode = document) => {
        const out = [...rootNode.querySelectorAll(selector)];
        const all = rootNode.querySelectorAll("*");
        for (const el of all) {
          if (el.shadowRoot) {
            out.push(...queryAllDeep(selector, el.shadowRoot));
          }
        }
        return out;
      };

      const findMore = () => {
        const allHits = queryAllDeep("button,[role=button],a,div,span,p,li").filter((el) => {
          if (el.children.length > 8) return false;
          if (!el.isConnected) return false;
          const raw = (
            /** @type {HTMLElement} */ (el).innerText ||
            el.textContent ||
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            ""
          ).trim();
          const clean = raw
            .replace(/[⌄˅▼▲\^<>‹›←→|•·\-_]+/g, " ")
            .replace(/[^a-zA-Z0-9\s]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          return (
            clean.length > 0 &&
            clean.length < 55 &&
            /^(?:view|show|load|see)\s*(?:all\s*)?more(?:\s*episodes?|\s*\d+)?$/i.test(clean) &&
            (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)
          );
        });
        const buttons = allHits.filter((el) => el.matches && el.matches("button,[role=button],a"));
        if (buttons.length) return /** @type {HTMLElement} */ (buttons[buttons.length - 1]);
        const innermost = allHits.filter((el) => !allHits.some((other) => other !== el && el.contains(other)));
        const list = innermost.length ? innermost : allHits;
        return list.length ? /** @type {HTMLElement} */ (list[list.length - 1]) : null;
      };

      // Support all separators: dot, colon, hyphen (\-), en/em dash, bullet (•), middle dot (·), pipe (|)
      const epLineRe =
        /(?:^|\b)(?:(?:S|Season)\s*\d+[\s.:–—\-•·|,]*)?(?:E|Ep\.?|Episode)\s*(\d{1,3})\b[\s.:–—\-•·|,]*(.*)$/i;

      const isMetaOnlyText = (s) =>
        !s ||
        /^(?:\d+\s*[a-zA-Z]+\s*\d*|\d+\s*h(?:\s*\d+\s*m(?:in)?)?|\d+\s*m(?:in|ins|inutes)?|[•·|–—\-\s\d.:,])+$/i.test(
          s
        );

      // Extract episode number and title even if the title appears on an adjacent line
      const extractEpFromEl = (el) => {
        const t = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
        if (!t || t.length > 360) return null;
        const lines = t
          .split("\n")
          .map((l) => l.replace(/\s+/g, " ").trim())
          .filter(Boolean);
        for (let idx = 0; idx < lines.length; idx++) {
          const m = lines[idx].match(epLineRe);
          if (m) {
            const n = parseInt(m[1], 10);
            if (n <= 0 || n > 1500) continue;
            let epTitle = m[2] ? m[2].trim() : "";
            if (isMetaOnlyText(epTitle)) {
              epTitle = "";
              if (idx > 0 && lines[idx - 1].length > 2 && !epLineRe.test(lines[idx - 1]) && !isMetaOnlyText(lines[idx - 1])) {
                epTitle = lines[idx - 1];
              } else if (
                idx + 1 < lines.length &&
                lines[idx + 1].length > 2 &&
                !epLineRe.test(lines[idx + 1]) &&
                !isMetaOnlyText(lines[idx + 1])
              ) {
                epTitle = lines[idx + 1];
              }
            }
            return { n, epTitle };
          }
        }
        return null;
      };

      // Detect total episodes count if stated on page or drawer header (e.g. "18 Eps", "52 Episodes", "Season 17 18 Eps")
      const detectExpectedTotal = () => {
        let best = null;
        const matches = [...(document.body?.innerText || "").matchAll(/\b(\d{1,3})\s*(?:Eps?\b|Episodes?\b)/gi)];
        for (const m of matches) {
          const num = parseInt(m[1], 10);
          if (num > 1 && num < 500 && (!best || num > best)) best = num;
        }
        const headerEls = queryAllDeep("h1,h2,h3,h4,h5,h6,div,span,header,p");
        for (const el of headerEls) {
          if (el.children.length > 5) continue;
          const t = (el.innerText || el.textContent || "").trim();
          if (t.length > 80) continue;
          const m = t.match(/\b(?:Season\s*\d+\s*)?(\d{1,3})\s*(?:Eps?\b|Episodes?\b)/i);
          if (m) {
            const num = parseInt(m[1], 10);
            if (num > 1 && num < 500 && (!best || num > best)) best = num;
          }
        }
        return best;
      };

      const fire = (el) => {
        const nodes = [/** @type {HTMLElement} */ (el)];
        if (el.parentElement && el.parentElement.getBoundingClientRect().width < 400) {
          nodes.push(el.parentElement);
        }
        const closest = /** @type {HTMLElement | null} */ (el.closest && el.closest("button,[role=button],a"));
        if (closest && closest.getBoundingClientRect().width < 400 && !nodes.includes(closest)) {
          nodes.push(closest);
        }
        for (const node of nodes) {
          try { node.focus(); } catch (_) {}
          try { node.click(); } catch (_) {}
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            try {
              node.dispatchEvent(
                new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, view: window })
              );
            } catch (_) {}
            try {
              node.dispatchEvent(
                new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window })
              );
            } catch (_) {}
          }
        }
      };

      // Clean single-target click so toggle buttons (like the 4-boxes icon or View More) never double-toggle
      const clickSingleTarget = (btn) => {
        if (!btn) return;
        const target = /** @type {HTMLElement} */ ((btn.closest && btn.closest("button,[role=button],a")) || btn);
        const r = target.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        try { target.focus(); } catch (_) {}
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
          try {
            target.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                clientX: cx,
                clientY: cy
              })
            );
          } catch (_) {}
          try {
            target.dispatchEvent(
              new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                clientX: cx,
                clientY: cy
              })
            );
          } catch (_) {}
        }
        try { target.click(); } catch (_) {}
      };

      /** @type {Map<number, HTMLElement>} */
      const cardElByNum = new Map();

      // Check whether an episode element sits inside a container that holds multiple episodes
      const isInsideMultiEpisodeList = (el) => {
        let anc = el.parentElement;
        for (let d = 0; d < 12 && anc && anc !== document.body; d++, anc = anc.parentElement) {
          const txt = (/** @type {HTMLElement} */ (anc).innerText || anc.textContent || "").trim();
          const epNums = new Set();
          for (const line of txt.split("\n")) {
            const m = line.replace(/\s+/g, " ").trim().match(epLineRe);
            if (m) epNums.add(parseInt(m[1], 10));
            if (epNums.size > 1) return true;
          }
        }
        return false;
      };

      // Ignore the top-left player header overlay (e.g. "S1 · E5 Body Jac") when it is not part of a multi-episode list
      const isPlayerTopLeftOverlay = (el) => {
        const b = el.getBoundingClientRect();
        return b.top >= 0 && b.top < 120 && b.left >= 0 && b.left < 450 && !isInsideMultiEpisodeList(el);
      };

      // Return the bottom-most episode card element inside the drawer/list
      const getBottomListCardEl = (descending = false) => {
        if (cardElByNum.size > 0) {
          const targetNum = descending
            ? Math.min(...cardElByNum.keys())
            : Math.max(...cardElByNum.keys());
          const edgeEl = cardElByNum.get(targetNum);
          if (edgeEl && edgeEl.isConnected) return edgeEl;
        }
        let bottomEl = null;
        let maxBottom = -Infinity;
        for (const el of cardElByNum.values()) {
          if (!el || !el.isConnected) continue;
          const b = el.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) continue;
          if (b.bottom > maxBottom) {
            maxBottom = b.bottom;
            bottomEl = el;
          }
        }
        return bottomEl;
      };

      const getCardScrollContainers = () => {
        const containers = new Set();
        for (const el of cardElByNum.values()) {
          let anc = el ? el.parentElement : null;
          while (anc && anc !== document.body && anc !== document.documentElement) {
            if (anc.scrollHeight > anc.clientHeight + 5) {
              containers.add(anc);
            }
            anc = anc.parentElement;
          }
        }
        return [...containers];
      };

      const getScrollContainers = () => {
        const containers = new Set(getCardScrollContainers());
        for (const d of queryAllDeep(
          "aside, [role=region], [role=dialog], [class*='drawer'], [class*='tray'], [class*='sidebar'], [class*='panel'], [class*='episode'], [class*='scroll'], div, section, main, ul"
        )) {
          if (d.scrollHeight > d.clientHeight + 10) {
            const s = window.getComputedStyle(d);
            if (
              s.overflowY === "auto" ||
              s.overflowY === "scroll" ||
              s.overflowY === "overlay" ||
              d.scrollTop > 0
            ) {
              containers.add(d);
            }
          }
        }
        return [...containers];
      };

      const canScrollMore = () => {
        const cardConts = getCardScrollContainers();
        const pool = cardConts.length ? cardConts : getScrollContainers();
        return pool.some((c) => c.scrollTop + c.clientHeight < c.scrollHeight - 8);
      };

      const scrollToTop = () => {
        try { window.scrollTo({ top: 0, behavior: "instant" }); } catch (_) {}
        for (const c of getScrollContainers()) {
          try {
            c.scrollTop = 0;
            c.dispatchEvent(new Event("scroll", { bubbles: true }));
          } catch (_) {}
        }
      };

      // Scroll incrementally so virtualized drawers mount every middle card without skipping
      const scrollDown = (descending = false) => {
        const containers = getScrollContainers();
        for (const c of containers) {
          try {
            const step = Math.max(220, Math.floor(c.clientHeight * 0.65));
            c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + step);
            c.dispatchEvent(new Event("scroll", { bubbles: true }));
          } catch (_) {}
        }
        const bottomCard = getBottomListCardEl(descending);
        if (bottomCard && containers.length === 0) {
          try {
            bottomCard.scrollIntoView({ block: "end", behavior: "instant" });
          } catch (_) {}
        }
        if (bottomCard) {
          try {
            bottomCard.dispatchEvent(
              new WheelEvent("wheel", { deltaY: 360, bubbles: true, cancelable: true, view: window })
            );
          } catch (_) {}
        }
        try {
          window.scrollBy({ top: Math.max(300, Math.floor(window.innerHeight * 0.65)), behavior: "instant" });
        } catch (_) {}
      };

      // Walk up from an episode number element to find the single-episode card container
      const findCardRoot = (el) => {
        let best = el.parentElement || el;
        let anc = el.parentElement;
        for (let d = 0; d < 7 && anc && anc !== document.body; d++, anc = anc.parentElement) {
          const r = anc.getBoundingClientRect();
          if (r.height > 420 || r.width > 950) break;
          const txt = (/** @type {HTMLElement} */ (anc).innerText || anc.textContent || "").trim();
          const epNums = new Set();
          for (const line of txt.split("\n")) {
            const m = line.replace(/\s+/g, " ").trim().match(epLineRe);
            if (m) epNums.add(parseInt(m[1], 10));
          }
          if (epNums.size > 1) break;
          best = anc;
        }
        return best;
      };

      // Count distinct episode numbers currently visible on screen.
      const countVisibleDistinctEpisodes = () => {
        const seen = new Set();
        for (const el of queryAllDeep(CANDIDATE_SEL)) {
          if (el.children.length > 10) continue;
          const info = extractEpFromEl(el);
          if (info && visible(el) && !isPlayerTopLeftOverlay(el)) {
            seen.add(info.n);
          }
        }
        return seen.size;
      };

      const hasVisibleCards = () => countVisibleDistinctEpisodes() >= 2;

      const wakePlayerControls = () => {
        const w = window.innerWidth || 1280;
        const h = window.innerHeight || 720;
        const points = [
          [w / 2, h / 2],
          [42, h / 2],
          [w - 200, 42],
          [w - 100, 42],
          [w / 2, Math.max(0, h - 55)],
          [w / 3, Math.max(0, h - 45)],
          [220, Math.max(0, h - 45)]
        ];
        const targets = new Set([
          document.body,
          document.documentElement,
          ...queryAllDeep("video, [class*='player'], [id*='player'], [data-testid*='player']")
        ]);
        for (const [x, y] of points) {
          const hit = document.elementFromPoint(x, y);
          if (hit) {
            targets.add(hit);
            if (hit.parentElement) targets.add(hit.parentElement);
          }
        }
        for (const [x, y] of points) {
          for (const t of targets) {
            if (!t) continue;
            for (const type of ["pointerover", "pointerenter", "pointermove", "mouseover", "mouseenter", "mousemove"]) {
              try {
                t.dispatchEvent(
                  new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window,
                    clientX: x,
                    clientY: y
                  })
                );
              } catch (_) {}
              try {
                t.dispatchEvent(
                  new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window,
                    clientX: x,
                    clientY: y
                  })
                );
              } catch (_) {}
            }
          }
        }
      };

      // Locate the left-side circular 4-boxes grid icon button that toggles the episode list drawer
      const findLeftBoxesButton = () => {
        // Direct class / attribute match first
        const directMatch = document.querySelector(
          ".unified-episodes-toggle, .unified-watch-episodes-toggle, button[aria-label*='episodes' i], button[title*='episodes' i]"
        );
        if (directMatch && visible(directMatch)) return /** @type {HTMLElement} */ (directMatch);

        const h = window.innerHeight || 720;
        const candidates = queryAllDeep("button, [role=button], a, div, span").filter((el) => {
          const b = el.getBoundingClientRect();
          if (b.width < 22 || b.width > 120 || b.height < 22 || b.height > 120) return false;
          if (b.left < 0 || b.left > 180) return false;
          if (b.top < h * 0.15 || b.bottom > h * 0.88) return false;
          const hasSvgOrIcon = !!(el.querySelector("svg, img, i, canvas") || el.tagName.toLowerCase() === "svg");
          if (!hasSvgOrIcon) return false;
          const txt = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
          return txt.length <= 16;
        });
        if (!candidates.length) return null;
        // Prefer interactive button/role=button elements closest to the vertical center
        const interactive = candidates.filter((el) => el.matches && el.matches("button, [role=button], a"));
        const pool = interactive.length ? interactive : candidates;
        pool.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return Math.abs(ra.top + ra.height / 2 - h / 2) - Math.abs(rb.top + rb.height / 2 - h / 2);
        });
        return /** @type {HTMLElement} */ (pool[0]);
      };

      let openedDrawerBtn = null;

      // Auto-open drawer / sidebar if episode list is not currently open
      const ensureDrawerOpen = async () => {
        if (hasVisibleCards()) return true;

        for (let attempt = 0; attempt < 3; attempt++) {
          wakePlayerControls();
          await wait(300);
          if (hasVisibleCards()) return true;

          // 1. Try explicit "Episodes" text / aria-label buttons
          const allElements = queryAllDeep("button, [role=button], a, div, span, p");
          const matches = allElements.filter((el) => {
            if (el.children.length > 5) return false;
            const text = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
            const aria = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
            if (/\bnext\s*episode\b/i.test(text) || /\bnext\s*episode\b/i.test(aria)) return false;
            if (/\b(?:S\d+\s*)?(?:E|Ep\.?|Episode)\s*\d+\b/i.test(text)) return false;

            const cleanText = text.replace(/[<‹←>›→⌄˅^▲▼\s]+/g, " ").trim();
            const cleanAria = aria.replace(/[<‹←>›→⌄˅^▲▼\s]+/g, " ").trim();
            return (
              /^(?:view\s+|all\s+|see\s+)?episodes?$/i.test(cleanAria) ||
              (cleanText.length > 0 && cleanText.length < 30 && /^(?:view\s+|all\s+|see\s+)?episodes?$/i.test(cleanText))
            );
          });

          const innermost = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
          const candidates = innermost.length ? innermost : matches;

          for (const cand of candidates) {
            clickSingleTarget(cand);
            for (let w = 0; w < 8; w++) {
              await wait(250);
              if (hasVisibleCards()) return true;
            }
          }

          // 2. Try clicking the left-side 4-boxes grid icon button
          const leftBoxesBtn = findLeftBoxesButton();
          if (leftBoxesBtn) {
            clickSingleTarget(leftBoxesBtn);
            for (let w = 0; w < 10; w++) {
              await wait(250);
              if (hasVisibleCards()) {
                openedDrawerBtn = leftBoxesBtn;
                return true;
              }
            }
          }
        }

        return hasVisibleCards();
      };

      const harvested = new Map();
      const firstSeenOrder = [];

      const harvestVisible = () => {
        const currentSlice = [];
        const candidateEls = queryAllDeep(CANDIDATE_SEL);
        for (const el of candidateEls) {
          if (el.children.length > 10) continue;
          const info = extractEpFromEl(el);
          if (info && visible(el) && !isPlayerTopLeftOverlay(el)) {
            const { n } = info;
            let epTitle = info.epTitle;
            const card = findCardRoot(el);

            if (isMetaOnlyText(epTitle)) {
              epTitle = "";
              if (card) {
                const textNodes = [...card.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,p,strong,b")].filter((node) => {
                  if (node === el || node.contains(el) || el.contains(node)) return false;
                  if (node.children.length > 3) return false;
                  const txt = (/** @type {HTMLElement} */ (node).innerText || node.textContent || "").trim();
                  return (
                    txt.length > 2 &&
                    txt.length < 110 &&
                    !epLineRe.test(txt) &&
                    !isMetaOnlyText(txt) &&
                    !/^(?:Season|S)\s*\d+/i.test(txt)
                  );
                });
                if (textNodes.length) {
                  epTitle = (/** @type {HTMLElement} */ (textNodes[0]).innerText || textNodes[0].textContent || "")
                    .trim()
                    .split("\n")[0];
                }
              }
            }

            // Extract watch href (supporting <a> tags and HTML5 data-navigation-href / data-href)
            let href = null;
            const getHrefFromNode = (node) => {
              if (!node) return null;
              if (node.matches && node.matches("a[href]")) return /** @type {HTMLAnchorElement} */ (node).href;
              const nav = node.getAttribute && (node.getAttribute("data-navigation-href") || node.getAttribute("data-href"));
              if (nav) {
                try { return new URL(nav, window.location.href).href; } catch (_) { return nav; }
              }
              return null;
            };

            href = getHrefFromNode(card) || getHrefFromNode(el);
            if (!href && card) {
              const a = card.querySelector("a[href], [data-navigation-href], [data-href]");
              if (a) href = getHrefFromNode(a);
            }
            if (!href) {
              let anc = el;
              for (let d = 0; d < 6 && anc && !href; d++, anc = anc.parentElement) {
                href = getHrefFromNode(anc);
                if (!href && anc.querySelectorAll) {
                  const inside = anc.querySelectorAll("a[href], [data-navigation-href], [data-href]");
                  if (inside.length === 1) href = getHrefFromNode(inside[0]);
                }
              }
            }

            const cardEl = /** @type {HTMLElement} */ (card || el);
            if (isInsideMultiEpisodeList(el) || !cardElByNum.has(n)) {
              cardElByNum.set(n, cardEl);
            }
            currentSlice.push(n);

            if (!harvested.has(n)) {
              harvested.set(n, { n, title: epTitle, href });
              firstSeenOrder.push(n);
            } else {
              const existing = harvested.get(n);
              if (!existing.href && href) existing.href = href;
              if ((!existing.title || existing.title.length < 3) && epTitle) existing.title = epTitle;
            }
          }
        }
        return currentSlice;
      };

      // 1. Ensure drawer is opened, harvest initial visible slice to lock onto the drawer's scroll container, then scroll to top
      await ensureDrawerOpen();
      harvestVisible();
      scrollToTop();
      await wait(380);
      firstSeenOrder.length = 0;
      harvestVisible();

      let isDescending = false;
      const checkDirection = () => {
        if (firstSeenOrder.length >= 2) {
          let desc = 0;
          let asc = 0;
          for (let k = 0; k < firstSeenOrder.length - 1; k++) {
            if (firstSeenOrder[k] > firstSeenOrder[k + 1]) desc++;
            else if (firstSeenOrder[k] < firstSeenOrder[k + 1]) asc++;
          }
          if (desc !== asc) isDescending = desc > asc;
        }
      };
      checkDirection();

      let expectedTotal = detectExpectedTotal();
      const startBtn = !!findMore();
      let clicks = 0;
      let stagnant = 0;

      // 2. Downward incremental expansion loop
      for (let i = 0; i < 65; i++) {
        const stillScrollable = canScrollMore();
        scrollDown(isDescending);
        await wait(280);
        const beforeCount = harvested.size;
        harvestVisible();
        checkDirection();
        if (!expectedTotal) expectedTotal = detectExpectedTotal();

        // If total count is specified and satisfied, we're done
        if (expectedTotal && harvested.size >= expectedTotal) {
          break;
        }

        // If descending and we've reached Episode 1, check if finished
        if (isDescending && harvested.has(1) && !canScrollMore()) {
          const btn = findMore();
          if (!btn) break;
          if (stagnant >= 1) break;
        }

        const btn = findMore();
        if (!btn) {
          if (stillScrollable || canScrollMore()) {
            stagnant = 0;
            continue;
          }
          const maxNoBtnStagnant = expectedTotal && harvested.size < expectedTotal ? 8 : 3;
          if (harvested.size <= beforeCount) {
            if (++stagnant >= maxNoBtnStagnant) break;
          } else {
            stagnant = 0;
          }
          continue;
        }

        try {
          btn.scrollIntoView({ block: "center", behavior: "instant" });
        } catch (_) {}
        await wait(200);
        clickSingleTarget(btn);
        clicks++;

        let grew = false;
        for (let w = 0; w < 20; w++) {
          await wait(320);
          if (w === 6 && harvested.size <= beforeCount) {
            const retryBtn = findMore() || btn;
            fire(retryBtn);
          }
          scrollDown(isDescending);
          harvestVisible();
          checkDirection();
          if (harvested.size > beforeCount) {
            grew = true;
            break;
          }
        }

        if (grew) {
          stagnant = 0;
        } else {
          const maxStagnant =
            (isDescending && !harvested.has(1)) || (expectedTotal && harvested.size < expectedTotal) ? 5 : 3;
          if (++stagnant >= maxStagnant) {
            break;
          }
        }
      }

      // 3. Descending or incomplete expectedTotal recovery: push to bottom and click View More
      if ((isDescending && !harvested.has(1)) || (expectedTotal && harvested.size < expectedTotal)) {
        for (let attempt = 0; attempt < 5; attempt++) {
          scrollDown(isDescending);
          await wait(450);
          const btn = findMore();
          if (btn) {
            try { btn.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
            await wait(150);
            clickSingleTarget(btn);
            fire(btn);
            clicks++;
            await wait(850);
          }
          harvestVisible();
          if (isDescending && harvested.has(1)) break;
          if (expectedTotal && harvested.size >= expectedTotal) break;
        }
      }

      // 4. Gap check and upward sweep for virtualized DOM recovery
      const allNums = [...harvested.keys()];
      if (allNums.length > 0) {
        const minNum = Math.min(...allNums);
        const maxNum = Math.max(...allNums);
        const missing = [];
        for (let k = Math.max(1, minNum); k <= maxNum; k++) {
          if (!harvested.has(k)) missing.push(k);
        }
        if (missing.length > 0) {
          for (let step = 0; step < 12; step++) {
            for (const c of getScrollContainers()) {
              try { c.scrollTop = Math.max(0, c.scrollTop - Math.max(220, Math.floor(c.clientHeight * 0.7))); } catch (_) {}
            }
            try { window.scrollBy({ top: -Math.floor(window.innerHeight * 0.7), behavior: "instant" }); } catch (_) {}
            await wait(280);
            harvestVisible();
            const stillMissing = missing.filter((k) => !harvested.has(k));
            if (!stillMissing.length) break;
          }
        }
      }

      // If we opened the left-side 4-boxes drawer to scan, close it so it doesn't cover the player controls
      if (openedDrawerBtn && hasVisibleCards()) {
        clickSingleTarget(openedDrawerBtn);
        await wait(200);
      }

      // 5. Completion assessment
      const hasMoreBtn = !!findMore();
      let stillHasMore = false;
      if (isDescending) {
        stillHasMore = !harvested.has(1) && hasMoreBtn;
      } else if (expectedTotal) {
        stillHasMore = harvested.size < expectedTotal && hasMoreBtn;
      } else {
        stillHasMore = hasMoreBtn && stagnant >= 3;
      }

      return {
        startBtn,
        clicks,
        isDescending,
        stillHasMore,
        cards: [...harvested.values()].sort((a, b) => a.n - b.n)
      };
    };

    const frameRuns = await Hud.injectAllFrames(tabId, scanInFrame);
    let res = null;
    let bestFrameId = 0;
    if (frameRuns && frameRuns.length > 0) {
      const sorted = [...frameRuns].sort(
        (a, b) => ((b.result?.cards?.length) || 0) - ((a.result?.cards?.length) || 0)
      );
      if (sorted[0] && sorted[0].result && sorted[0].result.cards && sorted[0].result.cards.length > 0) {
        res = sorted[0].result;
        bestFrameId = sorted[0].frameId;
      } else {
        const topFrame = frameRuns.find((f) => f.frameId === 0);
        res = topFrame ? topFrame.result : sorted[0]?.result;
      }
    } else {
      res = await Hud.inject(tabId, scanInFrame);
    }
    if (S) {
      S.drawerFrameId = bestFrameId;
    }

    if (!res) {
      return {
        ok: false,
        diag: "could not run on this page",
        reason: "Open a series page with an episode list first."
      };
    }
    const orderLabel = res.isDescending ? "Descending" : "Ascending";
    const diag = `clicks: ${res.clicks}; episodes: ${res.cards.length} (${orderLabel})`;
    if (!res.cards.length) {
      return { ok: false, diag, reason: "No episode cards found on this page." };
    }

    /** @type {Record<number, { n: number, title: string, href: string | null }>} */
    const map = {};
    res.cards.forEach((c) => (map[c.n] = c));
    const nums = res.cards.map((c) => c.n);
    const max = Math.max(...nums);
    const gaps = Config.range(1, max).filter((n) => !nums.includes(n));
    return {
      ok: true,
      complete: !res.stillHasMore,
      count: nums.length,
      max,
      gaps,
      withLinks: res.cards.filter((c) => c.href).length,
      map,
      diag
    };
  }

  async function waitTabComplete(tabId, timeoutMs = 30000) {
    const t0 = Date.now();
    let sawLoading = false;
    while (Date.now() - t0 < timeoutMs) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return false;
      if (tab.status === "loading") sawLoading = true;
      else if (sawLoading || Date.now() - t0 > 3000) return true;
      await Config.sleep(300);
    }
    return false;
  }

  const withWatch = (u) => (/[?&]watch=true/.test(u) ? u : u + (u.includes("?") ? "&" : "?") + "watch=true");

  /**
   * Detect the episode number currently loaded in the video player from URL, top-left player header, or document title.
   * @param {number} tabId
   * @returns {Promise<number | null>}
   */
  async function detectCurrentPlayingEpisode(tabId) {
    const runs = await Hud.injectAllFrames(tabId, () => {
      const curUrl = window.location.href || "";
      const urlEp = curUrl.match(/(?:[?&]episode=|\/episode[-_/]?|\/ep[-_/]?)0*(\d{1,4})\b/i);
      if (urlEp) {
        const num = parseInt(urlEp[1], 10);
        if (num > 0) return num;
      }

      const epHeaderRe =
        /(?:^|\b)(?:(?:S|Season)\s*\d+[\s.:–—\-•·|,]*)?(?:E|Ep\.?|Episode)\s*0*(\d{1,3})\b/i;
      const topLeftEls = document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,p");
      for (const el of topLeftEls) {
        if (el.children.length > 5) continue;
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.height > 0 && b.top >= 0 && b.top < 140 && b.left >= 0 && b.left < 480) {
          const txt = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
          const m = txt.match(epHeaderRe);
          if (m) {
            const num = parseInt(m[1], 10);
            if (num > 0) return num;
          }
        }
      }

      const title = document.title || "";
      const titleMatch = title.match(/\b(?:E|Ep\.?|Episode)\s*0*(\d{1,3})\b/i);
      if (titleMatch) {
        const num = parseInt(titleMatch[1], 10);
        if (num > 0) return num;
      }
      return null;
    });
    for (const r of runs) {
      if (typeof r.result === "number" && r.result > 0) return r.result;
    }
    return null;
  }

  /**
   * Check whether the tab is already displaying the target episode (e.g. Episode 1 when starting from watch page).
   * @param {number} tabId
   * @param {number} epNum
   * @param {string | null} expectedHref
   */
  async function isAlreadyOnEpisode(tabId, epNum, expectedHref) {
    const curEp = await detectCurrentPlayingEpisode(tabId);
    if (curEp != null) {
      return curEp === epNum;
    }
    return Hud.inject(
      tabId,
      (n, hrefTarget) => {
        const curUrl = window.location.href || "";
        if (hrefTarget) {
          const cleanCur = curUrl.split("?")[0].replace(/\/$/, "");
          const cleanTarget = String(hrefTarget).split("?")[0].replace(/\/$/, "");
          if (cleanCur && cleanCur === cleanTarget) return true;
        }
        const title = document.title || "";
        const titleRe = new RegExp(`\\b(?:E|Ep\\.?|Episode)\\s*0*${n}\\b`, "i");
        if (titleRe.test(title)) return true;
        return false;
      },
      [epNum, expectedHref || ""]
    );
  }

  /**
   * Automatically open "Audio & Subtitles" (or CC menu) in the player and select "English" (or preferred language)
   * so unencrypted subtitle tracks are requested and downloaded.
   * @param {number} tabId
   * @param {string} [prefLang="en"]
   */
  async function ensureSubtitlesEnabled(tabId, prefLang = "en") {
    const runs = await Hud.injectAllFrames(
      tabId,
      async (langCode) => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const visible = (el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0;
        };

        const queryAllDeep = (selector, rootNode = document) => {
          const out = [...rootNode.querySelectorAll(selector)];
          const all = rootNode.querySelectorAll("*");
          for (const el of all) {
            if (el.shadowRoot) {
              out.push(...queryAllDeep(selector, el.shadowRoot));
            }
          }
          return out;
        };

        const videos = queryAllDeep("video");
        if (!videos.length) return { ok: false, reason: "no-video" };

        const bodyText = document.body?.innerText || "";
        // Guard: If the player is actively connecting / loading / buffering, DO NOT interact with menu or conclude no subtitles!
        const isLoading =
          /contacting\s+[a-z0-9_-]+|connecting(?:\s*\.{3}|\s*to\b)?|buffering(?:\s*\.{3})?|resolving\s+server|fetching\s+sources?|extracting\b|please\s*wait/i.test(
            bodyText
          ) || videos.some((v) => (v.networkState === 2 && v.readyState < 3) || v.seeking || v.readyState < 2);
        if (isLoading) {
          return { ok: false, isLoading: true, noSubtitlesAvailable: false };
        }

        // Enable any native HTML5 textTracks matching English / preferred language
        for (const v of videos) {
          if (!v.textTracks) continue;
          for (let i = 0; i < v.textTracks.length; i++) {
            const tt = v.textTracks[i];
            if (!tt) continue;
            const l = `${tt.language || ""} ${tt.label || ""}`.toLowerCase();
            if (/en|eng|english/i.test(l) || v.textTracks.length === 1) {
              try {
                if (tt.mode !== "showing") tt.mode = "showing";
              } catch (_) {}
            }
          }
        }

        const clickSingle = (btn) => {
          if (!btn) return;
          const target = /** @type {HTMLElement} */ (
            (btn.closest && btn.closest("button,[role=button],[role=menuitem],[role=option],a,li")) || btn
          );
          const r = target.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          try { target.focus(); } catch (_) {}
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
            try {
              target.dispatchEvent(
                new PointerEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  view: window,
                  clientX: cx,
                  clientY: cy
                })
              );
            } catch (_) {}
            try {
              target.dispatchEvent(
                new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  view: window,
                  clientX: cx,
                  clientY: cy
                })
              );
            } catch (_) {}
          }
          try { target.click(); } catch (_) {}
        };

        // Wake player controls along top-right bar and center
        const w = window.innerWidth || 1280;
        const h = window.innerHeight || 720;
        for (const [x, y] of [
          [w / 2, h / 2],
          [w - 220, 42],
          [w - 110, 42],
          [w / 2, Math.max(0, h - 50)]
        ]) {
          const hit = document.elementFromPoint(x, y) || document.body;
          for (const t of [hit, document.body, ...videos]) {
            if (!t) continue;
            for (const type of ["pointerover", "pointerenter", "pointermove", "mouseover", "mouseenter", "mousemove"]) {
              try {
                t.dispatchEvent(
                  new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window,
                    clientX: x,
                    clientY: y
                  })
                );
              } catch (_) {}
            }
          }
        }
        await wait(250);

        const isSubMenuOpen = () =>
          queryAllDeep("div,span,p,button,li,label").some((el) => {
            if (el.children.length > 3 || !visible(el)) return false;
            const txt = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
            return /^(?:upload\s*subtitles|customize\s*appearance|sync\s*to\s*audio)$/i.test(txt);
          });

        const findAudioSubBtn = () => {
          const all = queryAllDeep("button, [role=button], a, div, span");
          const primary = all.filter((el) => {
            if (el.children.length > 5 || !visible(el)) return false;
            const txt = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
            const aria = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
            return /audio\s*(?:&|and)\s*subtitles?/i.test(txt) || /audio\s*(?:&|and)\s*subtitles?/i.test(aria);
          });
          if (primary.length) {
            const inner = primary.filter((el) => !primary.some((o) => o !== el && el.contains(o)));
            return /** @type {HTMLElement} */ ((inner.length ? inner : primary)[0]);
          }
          const secondary = all.filter((el) => {
            if (el.children.length > 4 || !visible(el)) return false;
            const txt = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
            const aria = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
            return (
              /^(?:subtitles?|captions?|closed\s*captions?)$/i.test(txt) ||
              /^(?:subtitles?|captions?|closed\s*captions?)$/i.test(aria)
            );
          });
          if (secondary.length) {
            const inner = secondary.filter((el) => !secondary.some((o) => o !== el && el.contains(o)));
            return /** @type {HTMLElement} */ ((inner.length ? inner : secondary)[0]);
          }
          return null;
        };

        let menuWasOpened = false;
        const audioSubBtn = findAudioSubBtn();
        if (!isSubMenuOpen() && audioSubBtn) {
          clickSingle(audioSubBtn);
          menuWasOpened = true;
          await wait(420);
        }

        // Find and click "English" under SUBTITLES
        const findEnglishOption = () => {
          const candidates = queryAllDeep(
            "button, [role=button], [role=menuitem], [role=option], li, div, span, p, a, label"
          ).filter((el) => {
            if (el.children.length > 4 || !visible(el)) return false;
            const b = el.getBoundingClientRect();
            if (b.width < 16 || b.width > 380 || b.height < 12 || b.height > 75) return false;
            const raw = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
            const clean = raw.replace(/[✓✔☑•·\s]+/g, " ").trim();
            return /^english(?:\s*\(?cc\)?|\s*\[cc\]|\s*sdh|\s*-\s*english)?$/i.test(clean);
          });
          if (!candidates.length) return null;
          const innermost = candidates.filter((el) => !candidates.some((o) => o !== el && el.contains(o)));
          const list = innermost.length ? innermost : candidates;
          return /** @type {HTMLElement} */ (list[0]);
        };

        const engOpt = findEnglishOption();
        let clickedEnglish = false;
        let noSubtitlesAvailable = false;
        if (engOpt) {
          clickSingle(engOpt);
          clickedEnglish = true;
          await wait(320);
        } else if (menuWasOpened || isSubMenuOpen()) {
          // Only evaluate "no subtitles available" if the player is actively playing
          // and the subtitle menu is rendered
          const isActivelyPlaying = videos.some((v) => !v.paused && v.currentTime > 1.0 && v.readyState >= 3);
          if (isActivelyPlaying) {
            const allMenuText = queryAllDeep("div,span,p,li,h3,h4,label")
              .map((el) => (el.innerText || el.textContent || "").trim())
              .join(" ")
              .toLowerCase();
            const hasExplicitNoSubs =
              allMenuText.includes("no subtitles available") ||
              allMenuText.includes("no captions available") ||
              allMenuText.includes("no subtitle tracks");

            const hasAnyLangTrack = queryAllDeep(
              "button, [role=button], [role=menuitem], [role=option], li, div, span"
            ).some((el) => {
              if (el.children.length > 3 || !visible(el)) return false;
              const t = (el.innerText || el.textContent || "").trim();
              return (
                /^(?:english|spanish|french|german|hindi|italian|japanese|korean|portuguese|russian|arabic|chinese|thai|vietnamese)\b/i.test(
                  t
                ) || /^[a-z]{2,3}(?:\s*\(.*\))?$/i.test(t)
              );
            });

            const hasSubtitlesSection = allMenuText.includes("subtitles") || allMenuText.includes("off");

            if (hasExplicitNoSubs || (hasSubtitlesSection && !hasAnyLangTrack && isSubMenuOpen())) {
              noSubtitlesAvailable = true;
            }
          }
        }

        // Close the Audio & Subtitles popover if it remains open so it doesn't obscure the player
        if ((menuWasOpened || isSubMenuOpen()) && isSubMenuOpen()) {
          const toggleBtn = findAudioSubBtn();
          if (toggleBtn) {
            clickSingle(toggleBtn);
          } else {
            try {
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
            } catch (_) {}
          }
          await wait(150);
        }

        return { ok: clickedEnglish || !!audioSubBtn, clickedEnglish, noSubtitlesAvailable };
      },
      [prefLang || "en"]
    );
    const clickedEnglish = runs.some((r) => r.result && r.result.clickedEnglish);
    const noSubtitlesAvailable = runs.some((r) => r.result && r.result.noSubtitlesAvailable);
    return {
      ok: clickedEnglish || runs.some((r) => r.result && r.result.ok),
      clickedEnglish,
      noSubtitlesAvailable
    };
  }

  /**
   * Click the "Next Episode" button in the player UI to advance sequentially.
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  async function clickNextEpisodeButton(tabId) {
    const runs = await Hud.injectAllFrames(tabId, async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const visible = (el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };
      const queryAllDeep = (selector, rootNode = document) => {
        const out = [...rootNode.querySelectorAll(selector)];
        const all = rootNode.querySelectorAll("*");
        for (const el of all) {
          if (el.shadowRoot) {
            out.push(...queryAllDeep(selector, el.shadowRoot));
          }
        }
        return out;
      };

      const w = window.innerWidth || 1280;
      const h = window.innerHeight || 720;
      for (const [x, y] of [
        [w / 2, h / 2],
        [w - 105, 42],
        [w - 200, 42],
        [w / 2, Math.max(0, h - 50)]
      ]) {
        const hit = document.elementFromPoint(x, y) || document.body;
        for (const t of [hit, document.body]) {
          if (!t) continue;
          for (const type of ["pointerover", "pointerenter", "pointermove", "mouseover", "mouseenter", "mousemove"]) {
            try {
              t.dispatchEvent(
                new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  view: window,
                  clientX: x,
                  clientY: y
                })
              );
            } catch (_) {}
          }
        }
      }
      await wait(250);

      const candidates = queryAllDeep("button, [role=button], a, div, span").filter((el) => {
        if (el.children.length > 5 || !visible(el)) return false;
        const b = el.getBoundingClientRect();
        if (b.width < 20 || b.width > 340 || b.height < 14 || b.height > 90) return false;
        const txt = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "")
          .replace(/[<‹←>›→|▸▶\s]+/g, " ")
          .trim();
        const aria = (el.getAttribute("aria-label") || el.getAttribute("title") || "")
          .replace(/[<‹←>›→|▸▶\s]+/g, " ")
          .trim();
        return /^(?:next\s*episode|next\s*ep)$/i.test(txt) || /^(?:next\s*episode|next\s*ep)$/i.test(aria);
      });

      if (!candidates.length) return false;
      const buttons = candidates.filter((el) => el.matches && el.matches("button, [role=button], a"));
      const innermost = candidates.filter((el) => !candidates.some((o) => o !== el && el.contains(o)));
      const target = /** @type {HTMLElement} */ ((buttons.length ? buttons : innermost.length ? innermost : candidates)[0]);

      const r = target.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      try { target.focus(); } catch (_) {}
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        try {
          target.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window,
              clientX: cx,
              clientY: cy
            })
          );
        } catch (_) {}
        try {
          target.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window,
              clientX: cx,
              clientY: cy
            })
          );
        } catch (_) {}
      }
      try { target.click(); } catch (_) {}
      return true;
    });
    return runs.some((r) => r.result === true);
  }

  /**
   * Switch to the next available server in "Servers & Mode" menu when current stream has no subtitles or is broken.
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  async function switchToNextStreamServer(tabId) {
    const runs = await Hud.injectAllFrames(tabId, async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const visible = (el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };

      const queryAllDeep = (selector, rootNode = document) => {
        const out = [...rootNode.querySelectorAll(selector)];
        const all = rootNode.querySelectorAll("*");
        for (const el of all) {
          if (el.shadowRoot) {
            out.push(...queryAllDeep(selector, el.shadowRoot));
          }
        }
        return out;
      };

      const clickSingle = (btn) => {
        if (!btn) return;
        const target = /** @type {HTMLElement} */ (
          (btn.closest && btn.closest("button,[role=button],[role=menuitem],[role=option],a,li")) || btn
        );
        const r = target.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        try { target.focus(); } catch (_) {}
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
          try {
            target.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                clientX: cx,
                clientY: cy
              })
            );
          } catch (_) {}
          try {
            target.dispatchEvent(
              new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                clientX: cx,
                clientY: cy
              })
            );
          } catch (_) {}
        }
        try { target.click(); } catch (_) {}
      };

      // 1. Find and click "Servers & Mode" dropdown button
      const allBtns = queryAllDeep("button, [role=button], a, div, span");
      const serverMenuBtn = allBtns.find((el) => {
        if (el.children.length > 4 || !visible(el)) return false;
        const txt = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
        return /servers?\s*(?:&|and)\s*mode/i.test(txt);
      });

      if (!serverMenuBtn) return false;
      clickSingle(serverMenuBtn);
      await wait(450);

      // 2. Locate unselected server options in the opened menu
      const serverCandidates = queryAllDeep(
        "button, [role=button], [role=menuitem], [role=option], li, div, span, a"
      ).filter((el) => {
        if (el.children.length > 3 || !visible(el)) return false;
        const b = el.getBoundingClientRect();
        if (b.width < 25 || b.width > 350 || b.height < 14 || b.height > 80) return false;
        const txt = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
        const isServerName =
          /^(?:vela|atlas|server\s*\d+|vidcloud|upcloud|megacloud|streamhub|dood|mixdrop|filemoon)\b/i.test(txt);
        const isSelected = /[✓✔☑]|active|selected/i.test(el.className) || el.getAttribute("aria-selected") === "true";
        return isServerName && !isSelected;
      });

      if (serverCandidates.length > 0) {
        const targetServer = /** @type {HTMLElement} */ (serverCandidates[0]);
        clickSingle(targetServer);
        await wait(500);
        return true;
      }

      // Close menu if no alternative unselected server was found
      clickSingle(serverMenuBtn);
      return false;
    });

    return runs.some((r) => r.result === true);
  }

  async function openEpisode(tabId, n, S, setStatus) {
    const curEp = await detectCurrentPlayingEpisode(tabId);
    if (curEp === n) {
      S.currentLoadedEp = n;
      return true;
    }

    // 1. If advancing sequentially to the immediate next episode (n === curEp + 1), try clicking the player's "Next Episode" button first
    // This avoids a full page reload, preventing Cloudflare CAPTCHAs and popup redirects on streaming sites like 7movies.
    if ((curEp != null && curEp === n - 1) || (curEp == null && S.currentLoadedEp === n - 1)) {
      const clickedNext = await clickNextEpisodeButton(tabId);
      if (clickedNext) {
        await Config.sleep(1800);
        await waitTabComplete(tabId, 12000);
        S.currentLoadedEp = n;
        return true;
      }
    }

    const entry = S.map[n];
    if (entry && entry.href) {
      await chrome.tabs.update(tabId, { url: withWatch(entry.href) });
      await waitTabComplete(tabId);
      S.currentLoadedEp = n;
      return true;
    }

    // 2. Try clicking the episode directly inside the current page or drawer (opening the left-side 4-boxes icon if needed)
    const clickInPageOrDrawer = async () =>
      Hud.inject(
        tabId,
        async (epNum) => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const visible = (el) => {
            const b = el.getBoundingClientRect();
            return b.width > 0 && b.height > 0;
          };
          const CANDIDATE_SEL =
            "h1,h2,h3,h4,h5,h6,div,span,p,a,button,li,small,strong,b,em,label,article,section";
          const queryAllDeep = (selector, rootNode = document) => {
            const out = [...rootNode.querySelectorAll(selector)];
            const all = rootNode.querySelectorAll("*");
            for (const el of all) {
              if (el.shadowRoot) {
                out.push(...queryAllDeep(selector, el.shadowRoot));
              }
            }
            return out;
          };
          const epLineRe =
            /(?:^|\b)(?:(?:S|Season)\s*\d+[\s.:–—\-•·|,]*)?(?:E|Ep\.?|Episode)\s*(\d{1,3})\b[\s.:–—\-•·|,]*(.*)$/i;

          const extractEpFromEl = (el) => {
            const t = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
            if (!t || t.length > 360) return null;
            const lines = t
              .split("\n")
              .map((l) => l.replace(/\s+/g, " ").trim())
              .filter(Boolean);
            for (let idx = 0; idx < lines.length; idx++) {
              const m = lines[idx].match(epLineRe);
              if (m) {
                const n = parseInt(m[1], 10);
                if (n > 0 && n < 1500) return { n, m };
              }
            }
            return null;
          };

          const clickSingle = (btn) => {
            if (!btn) return;
            const target = /** @type {HTMLElement} */ (
              (btn.closest && btn.closest("button,[role=button],a")) || btn
            );
            const r = target.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            try { target.focus(); } catch (_) {}
            for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
              try {
                target.dispatchEvent(
                  new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window,
                    clientX: cx,
                    clientY: cy
                  })
                );
              } catch (_) {}
              try {
                target.dispatchEvent(
                  new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window,
                    clientX: cx,
                    clientY: cy
                  })
                );
              } catch (_) {}
            }
            try { target.click(); } catch (_) {}
          };

          const fireClick = (el) => {
            const nodes = [/** @type {HTMLElement} */ (el)];
            if (el.parentElement && el.parentElement.getBoundingClientRect().width < 500) {
              nodes.push(el.parentElement);
            }
            const closest = /** @type {HTMLElement | null} */ (el.closest && el.closest("a,button,[role=button]"));
            if (closest && closest.getBoundingClientRect().width < 500 && !nodes.includes(closest)) {
              nodes.push(closest);
            }
            for (const node of nodes) {
              try { node.focus(); } catch (_) {}
              try { node.click(); } catch (_) {}
              for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
                try {
                  node.dispatchEvent(
                    new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, view: window })
                  );
                } catch (_) {}
                try {
                  node.dispatchEvent(
                    new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window })
                  );
                } catch (_) {}
              }
            }
          };

          const isListCard = (elNode) => {
            let anc = elNode.parentElement;
            for (let d = 0; d < 12 && anc && anc !== document.body; d++, anc = anc.parentElement) {
              const txt = (/** @type {HTMLElement} */ (anc).innerText || anc.textContent || "").trim();
              const epNums = new Set();
              for (const line of txt.split("\n")) {
                const m = line.replace(/\s+/g, " ").trim().match(epLineRe);
                if (m) epNums.add(parseInt(m[1], 10));
                if (epNums.size > 1) return true;
              }
            }
            return false;
          };

          const isTopLeftOverlay = (elNode) => {
            const b = elNode.getBoundingClientRect();
            return b.top >= 0 && b.top < 120 && b.left >= 0 && b.left < 450 && !isListCard(elNode);
          };

          const countDistinct = () => {
            const seen = new Set();
            for (const el of queryAllDeep(CANDIDATE_SEL)) {
              if (el.children.length > 10) continue;
              const info = extractEpFromEl(el);
              if (info && visible(el) && !isTopLeftOverlay(el)) seen.add(info.n);
            }
            return seen.size;
          };

          const findLeftBoxesBtn = () => {
            const h = window.innerHeight || 720;
            const cands = queryAllDeep("button, [role=button], a, div, span").filter((el) => {
              const b = el.getBoundingClientRect();
              if (b.width < 24 || b.width > 96 || b.height < 24 || b.height > 96) return false;
              if (b.left < 0 || b.left > 165) return false;
              if (b.top < h * 0.18 || b.bottom > h * 0.85) return false;
              const hasSvg = !!(el.querySelector("svg, img, i, canvas") || el.tagName.toLowerCase() === "svg");
              if (!hasSvg) return false;
              const txt = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
              return txt.length <= 4;
            });
            if (!cands.length) return null;
            const inter = cands.filter((el) => el.matches && el.matches("button, [role=button], a"));
            const pool = inter.length ? inter : cands;
            return /** @type {HTMLElement} */ (pool[0]);
          };

          // 1. Open drawer if not already open
          if (countDistinct() < 2) {
            const w = window.innerWidth || 1280;
            const h = window.innerHeight || 720;
            for (const [x, y] of [
              [w / 2, h / 2],
              [42, h / 2],
              [w / 2, Math.max(0, h - 55)],
              [w / 3, Math.max(0, h - 45)]
            ]) {
              const hit = document.elementFromPoint(x, y) || document.body;
              for (const type of ["pointermove", "mousemove", "mouseenter", "mouseover"]) {
                try {
                  hit.dispatchEvent(
                    new MouseEvent(type, {
                      bubbles: true,
                      cancelable: true,
                      composed: true,
                      view: window,
                      clientX: x,
                      clientY: y
                    })
                  );
                } catch (_) {}
              }
            }
            await wait(300);
            const all = queryAllDeep("button, [role=button], a, div, span, p");
            const matches = all.filter((el) => {
              if (el.children.length > 5) return false;
              const txt = (/** @type {HTMLElement} */ (el).innerText || el.textContent || "").trim();
              const aria = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
              if (/\bnext\s*episode\b/i.test(txt) || /\bnext\s*episode\b/i.test(aria)) return false;
              if (/\b(?:S\d+\s*)?(?:E|Ep\.?|Episode)\s*\d+\b/i.test(txt)) return false;
              const cleanT = txt.replace(/[<‹←>›→⌄˅^▲▼\s]+/g, " ").trim();
              const cleanA = aria.replace(/[<‹←>›→⌄˅^▲▼\s]+/g, " ").trim();
              return (
                /^(?:view\s+|all\s+|see\s+)?episodes?$/i.test(cleanA) ||
                (cleanT.length > 0 && cleanT.length < 30 && /^(?:view\s+|all\s+|see\s+)?episodes?$/i.test(cleanT))
              );
            });
            const innermost = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
            for (const cand of innermost.length ? innermost : matches) {
              clickSingle(cand);
              for (let k = 0; k < 8; k++) {
                await wait(250);
                if (countDistinct() >= 2) break;
              }
              if (countDistinct() >= 2) break;
            }
            if (countDistinct() < 2) {
              const leftBoxes = findLeftBoxesBtn();
              if (leftBoxes) {
                clickSingle(leftBoxes);
                for (let k = 0; k < 10; k++) {
                  await wait(250);
                  if (countDistinct() >= 2) break;
                }
              }
            }
          }

          // 2. Locate the target episode card, scrolling to top first if needed, then incrementally downward
          const findTargetCardEl = () => {
            const candidates = queryAllDeep(CANDIDATE_SEL).filter((e) => {
              if (e.children.length > 10 || !visible(e) || isTopLeftOverlay(e)) return false;
              const info = extractEpFromEl(e);
              return info && info.n === epNum;
            });
            const inList = candidates.filter((e) => isListCard(e));
            const pool = inList.length ? inList : candidates;
            return pool.length ? /** @type {HTMLElement} */ (pool[0]) : null;
          };

          const getDrawerScrollContainers = () => {
            const set = new Set();
            for (const e of queryAllDeep(CANDIDATE_SEL)) {
              if (e.children.length > 10 || !visible(e) || isTopLeftOverlay(e)) continue;
              if (extractEpFromEl(e)) {
                let anc = e.parentElement;
                while (anc && anc !== document.body && anc !== document.documentElement) {
                  if (anc.scrollHeight > anc.clientHeight + 5) set.add(anc);
                  anc = anc.parentElement;
                }
              }
            }
            return [...set];
          };

          let el = findTargetCardEl();
          if (!el) {
            for (const c of getDrawerScrollContainers()) {
              try {
                c.scrollTop = 0;
                c.dispatchEvent(new Event("scroll", { bubbles: true }));
              } catch (_) {}
            }
            await wait(300);
            el = findTargetCardEl();
          }

          for (let step = 0; step < 30 && !el; step++) {
            const conts = getDrawerScrollContainers();
            for (const c of conts) {
              try {
                c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + Math.max(220, Math.floor(c.clientHeight * 0.65)));
                c.dispatchEvent(new Event("scroll", { bubbles: true }));
              } catch (_) {}
            }
            const allCards = queryAllDeep(CANDIDATE_SEL).filter((e) => {
              if (e.children.length > 10 || !visible(e) || isTopLeftOverlay(e)) return false;
              const info = extractEpFromEl(e);
              return info && isListCard(e);
            });
            if (allCards.length && conts.length === 0) {
              try {
                allCards[allCards.length - 1].scrollIntoView({ block: "end", behavior: "instant" });
              } catch (_) {}
            }
            const moreHits = queryAllDeep("button,[role=button],a,div,span,p,li").filter((mEl) => {
              if (mEl.children.length > 6) return false;
              const raw = (
                /** @type {HTMLElement} */ (mEl).innerText ||
                mEl.textContent ||
                mEl.getAttribute("aria-label") ||
                ""
              ).trim();
              const clean = raw.replace(/[^a-zA-Z\s]+/g, " ").replace(/\s+/g, " ").trim();
              return (
                clean.length > 0 &&
                clean.length < 45 &&
                /^(?:view|show|load|see)\s*more(?:\s*episodes?)?$/i.test(clean) &&
                mEl.getClientRects().length > 0
              );
            });
            if (moreHits.length) {
              const rawBtn = /** @type {HTMLElement} */ (moreHits[moreHits.length - 1]);
              const btnTarget = /** @type {HTMLElement} */ (
                (rawBtn.closest && rawBtn.closest("button,[role=button],a")) || rawBtn
              );
              try { btnTarget.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
              await wait(150);
              clickSingle(btnTarget);
              await wait(600);
            } else {
              await wait(260);
            }
            el = findTargetCardEl();
          }

          if (!el) return false;
          el.scrollIntoView({ block: "center", behavior: "instant" });
          await wait(200);

          // Find cardRoot for this episode
          let cardRoot = el.parentElement || el;
          let anc = el.parentElement;
          for (let d = 0; d < 7 && anc && anc !== document.body; d++, anc = anc.parentElement) {
            const r = anc.getBoundingClientRect();
            if (r.height > 420 || r.width > 950) break;
            const txt = (/** @type {HTMLElement} */ (anc).innerText || anc.textContent || "").trim();
            const epNums = new Set();
            for (const line of txt.split("\n")) {
              const m = line.replace(/\s+/g, " ").trim().match(epLineRe);
              if (m) epNums.add(parseInt(m[1], 10));
            }
            if (epNums.size > 1) break;
            cardRoot = anc;
          }

          // Click play button / thumbnail / link / cardRoot / el (avoiding download icon buttons inside the card)
          const playTargets = [
            ...[...cardRoot.querySelectorAll("a[href], img")].filter((node) => {
              const aria = (node.getAttribute("aria-label") || node.getAttribute("title") || "").toLowerCase();
              return !/download/i.test(aria);
            }),
            cardRoot,
            el
          ];
          for (const pt of playTargets) {
            fireClick(pt);
          }
          return true;
        },
        [n],
        S && typeof S.drawerFrameId === "number" ? S.drawerFrameId : null
      );

    let clicked = await clickInPageOrDrawer();
    if (!clicked) {
      // Fallback: if URL has ?episode=X, update URL parameter directly
      const curTab = await chrome.tabs.get(tabId).catch(() => null);
      const curTabUrl = (curTab && curTab.url) || S.listUrl || "";
      if (/([?&]episode=)\d+/i.test(curTabUrl)) {
        const nextUrl = curTabUrl.replace(/([?&]episode=)\d+/i, `$1${n}`);
        await chrome.tabs.update(tabId, { url: nextUrl });
        await waitTabComplete(tabId);
        S.currentLoadedEp = n;
        return true;
      }
      if (S.listUrl) {
        await chrome.tabs.update(tabId, { url: S.listUrl });
        await waitTabComplete(tabId);
        await Config.sleep(2000);
        clicked = await clickInPageOrDrawer();
      }
    }
    if (!clicked) return false;
    await Config.sleep(1500);
    await waitTabComplete(tabId);
    // Verify if URL parameter needs updating when clicking card didn't change the episode
    const verifyEp = await detectCurrentPlayingEpisode(tabId);
    if (verifyEp != null && verifyEp !== n) {
      const curTab = await chrome.tabs.get(tabId).catch(() => null);
      const curTabUrl = (curTab && curTab.url) || "";
      if (/([?&]episode=)\d+/i.test(curTabUrl)) {
        await chrome.tabs.update(tabId, { url: curTabUrl.replace(/([?&]episode=)\d+/i, `$1${n}`) });
        await waitTabComplete(tabId);
      }
    }
    S.currentLoadedEp = n;
    return true;
  }

  const epFromUrl = (u) => {
    const m = String(u || "").match(/ep0*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  };
  const trackScore = (c) => {
    const s = `${c.url || ""} ${c.lang || ""} ${c.label || ""}`;
    const isNetworkFile = c.url && !String(c.url).startsWith("texttrack://");
    const cueBonus = Array.isArray(c.cues) && c.cues.length >= 50 ? 15 : 0;
    const netBonus = isNetworkFile ? 10 : -5;
    const langBonus = (/eng|\ben\b/i.test(s) ? 3 : 0) + (/hin|\bhi\b/i.test(s) ? -2 : 0);
    return cueBonus + netBonus + langBonus;
  };

  /**
   * Comprehensive health & lifecycle check for video players across OTT and streaming sites.
   * Accurately determines if the player is:
   *  1. isCrashed: MediaError, crash banner ("playback is unavailable", "media could not be loaded"), or retry prompt.
   *  2. isLoading: Connecting to media server ("CONTACTING VELA", "Connecting...", "Buffering..."), loading spinners, or video buffering.
   *  3. isPlaying: Video is actively advancing in playback (!paused, currentTime > 1.0, readyState >= 3).
   *  4. isReady: Video element has loaded metadata and frames (readyState >= 3).
   * @param {number} tabId
   */
  async function detectPlayerHealth(tabId) {
    const runs = await Hud.injectAllFrames(tabId, () => {
      try {
        const bodyText = document.body?.innerText || "";
        const bodyLower = bodyText.toLowerCase();

        // 1. Crash / Error detection
        const crashRegex =
          /playback\s*(?:is\s*)?temporarily\s*unavailable|playback\s*(?:is\s*)?not\s*available|could\s*not\s*load\s*(?:the\s*)?video|media\s*playback\s*error|the\s*media\s*could\s*not\s*be\s*loaded|no\s*playable\s*sources?\s*found|server\s*error|failed\s*to\s*load\s*resource|error\s*code\s*:/i;

        const retryBtns = [...document.querySelectorAll("button, [role=button], a, div, span")].filter((el) => {
          if (el.children.length > 2) return false;
          const t = (el.innerText || el.textContent || "").trim();
          return /^(?:retry|try\s*again|reload\s*player)$/i.test(t) && el.getClientRects().length > 0;
        });

        const videos = [...document.querySelectorAll("video")];
        const hasVideoError = videos.some((v) => v.error !== null);
        const isCrashed = hasVideoError || crashRegex.test(bodyLower) || (retryBtns.length > 0 && crashRegex.test(bodyLower));

        // 2. Loading / Buffering / Server Connecting detection
        const loadingRegex =
          /contacting\s+[a-z0-9_-]+|connecting(?:\s*\.{3}|\s*to\b)?|buffering(?:\s*\.{3})?|resolving\s+server|fetching\s+sources?|extracting\b|please\s*wait/i;
        const match = bodyText.match(loadingRegex);
        let loadingDetail = "";
        if (match) {
          loadingDetail = match[0].trim();
        }

        const hasLoaders =
          document.querySelectorAll(
            "[class*='loader'], [class*='spinner'], [class*='loading'], [class*='buffering'], [role='progressbar'], svg[class*='animate-spin']"
          ).length > 0;

        const hasLoadingVideo = videos.some(
          (v) => (v.networkState === 2 && v.readyState < 3) || v.seeking || (v.readyState < 2 && !v.error)
        );

        const isLoading = !isCrashed && (!!match || hasLoaders || hasLoadingVideo);

        // 3. Actively playing or ready
        const isPlaying = videos.some((v) => !v.paused && v.currentTime > 1.0 && v.readyState >= 3);
        const isReady = videos.some((v) => v.readyState >= 3);
        const activeVideo = videos.find((v) => !v.paused && v.currentTime > 0) || videos[0];
        const currentTime = activeVideo ? activeVideo.currentTime : 0;
        const duration = activeVideo ? activeVideo.duration : 0;

        return {
          isCrashed,
          hasRetryBtn: retryBtns.length > 0,
          isLoading,
          isPlaying,
          isReady,
          currentTime,
          duration,
          loadingDetail
        };
      } catch (_) {
        return {
          isCrashed: false,
          hasRetryBtn: false,
          isLoading: false,
          isPlaying: false,
          isReady: false,
          currentTime: 0,
          duration: 0,
          loadingDetail: ""
        };
      }
    });

    return {
      isCrashed: runs.some((r) => r.result && r.result.isCrashed),
      hasRetryBtn: runs.some((r) => r.result && r.result.hasRetryBtn),
      isLoading: runs.some((r) => r.result && r.result.isLoading),
      isPlaying: runs.some((r) => r.result && r.result.isPlaying),
      isReady: runs.some((r) => r.result && r.result.isReady),
      currentTime: Math.max(...runs.map((r) => (r.result && r.result.currentTime) || 0), 0),
      duration: Math.max(...runs.map((r) => (r.result && r.result.duration) || 0), 0),
      loadingDetail: runs.map((r) => r.result && r.result.loadingDetail).filter(Boolean)[0] || ""
    };
  }

  /**
   * Click the "Retry" button if present inside any frame.
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  async function clickRetryPlaybackButton(tabId) {
    const runs = await Hud.injectAllFrames(tabId, () => {
      try {
        const retryBtns = [...document.querySelectorAll("button, [role=button], a, div, span")].filter((el) => {
          if (el.children.length > 2) return false;
          const t = (el.innerText || el.textContent || "").trim();
          return /^(?:retry|try\s*again|reload\s*player)$/i.test(t) && el.getClientRects().length > 0;
        });
        if (retryBtns.length) {
          const btn = /** @type {HTMLElement} */ (retryBtns[0]);
          btn.click();
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            try {
              btn.dispatchEvent(
                new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window })
              );
            } catch (_) {}
          }
          return true;
        }
        return false;
      } catch (_) {
        return false;
      }
    });
    return runs.some((r) => r.result === true);
  }

  async function waitForSubtitle(tabId, n, t0, S, usedUrls = new Set(), timeoutMs = 35000) {
    let polls = 0;
    let hardReloadCount = 0;
    const maxHardReloads = 3;
    let playbackStartTime = null;

    while (S.enabled && Date.now() - t0 < timeoutMs) {
      if (S.skipRequested) {
        return { skippedByUser: true };
      }
      const allTracks = Registry.getTabTracks(tabId);
      const fresh = allTracks.filter((c) => {
        if (usedUrls.has(c.url)) return false;
        return (c.t || 0) >= t0;
      });

      // 1. Exact episode number in URL
      const exact = fresh.filter((c) => epFromUrl(c.url) === n);
      if (exact.length) {
        const best = exact.sort((a, b) => trackScore(b) - trackScore(a))[0];
        return { url: best.url, key: best.key, track: best, confirmed: true };
      }

      // 2. Network subtitle file (.vtt / .srt / .ttml) or populated track with >= 50 cues
      const strong = fresh.filter(
        (c) =>
          (c.url && !String(c.url).startsWith("texttrack://")) ||
          (Array.isArray(c.cues) && c.cues.length >= 50)
      );
      if (strong.length && (Date.now() - t0 > 2500 || (strong[0].cues && strong[0].cues.length >= 50))) {
        const best = strong.sort((a, b) => trackScore(b) - trackScore(a))[0];
        return { url: best.url, key: best.key, track: best, confirmed: true };
      }

      // 3. Fallback after 15s
      if (fresh.length && Date.now() - t0 > 15000) {
        const best = fresh.sort((a, b) => trackScore(b) - trackScore(a))[0];
        const e = epFromUrl(best.url);
        return {
          url: best.url,
          key: best.key,
          track: best,
          confirmed: false,
          note: e ? `file name says episode ${e}` : "file name has no episode number"
        };
      }

      // 4. Player Health Check
      const health = await detectPlayerHealth(tabId);

      // 4A. CRASH / ERROR HANDLING
      if (health.isCrashed) {
        if (health.hasRetryBtn) {
          setStatus(`Episode ${n}: Playback error detected. Clicking Retry...`);
          await clickRetryPlaybackButton(tabId);
          await Config.sleep(2000);
        }
        const postRetryHealth = await detectPlayerHealth(tabId);
        if (postRetryHealth.isCrashed) {
          if (hardReloadCount < maxHardReloads) {
            hardReloadCount++;
            setStatus(
              `Episode ${n}: Player crashed/unavailable. Hard reloading page (${hardReloadCount}/${maxHardReloads})...`
            );
            try {
              await chrome.tabs.reload(tabId, { bypassCache: true });
            } catch (_) {
              try {
                const curTab = await chrome.tabs.get(tabId);
                if (curTab && curTab.url) await chrome.tabs.update(tabId, { url: curTab.url });
              } catch (_) {}
            }
            await Config.sleep(2000);
            await waitTabComplete(tabId, 15000);
            await Config.sleep(2000);
            await Registry.ensureTabScriptsAndScan(tabId);
            t0 = Date.now(); // Reset timeout window for the fresh page load
            playbackStartTime = null;
            continue;
          } else {
            return { playerCrashed: true };
          }
        }
      }

      // 4B. LOADING / BUFFERING / CONNECTING TO SERVER
      if (health.isLoading) {
        playbackStartTime = null;
        const detail = health.loadingDetail || "Connecting to stream server / Buffering";
        setStatus(`Episode ${n}: ${detail}...`);

        // If stream has been stuck connecting/loading for > 30s without progress, trigger a hard reload
        if (Date.now() - t0 > 30000 && hardReloadCount < maxHardReloads) {
          hardReloadCount++;
          setStatus(
            `Episode ${n}: Stream stuck connecting for 30s. Hard reloading (${hardReloadCount}/${maxHardReloads})...`
          );
          try {
            await chrome.tabs.reload(tabId, { bypassCache: true });
          } catch (_) {}
          await waitTabComplete(tabId, 15000);
          await Config.sleep(2000);
          await Registry.ensureTabScriptsAndScan(tabId);
          t0 = Date.now();
          continue;
        }

        await Config.sleep(1200);
        polls++;
        continue;
      }

      // 4C. READY / PLAYING HANDLING
      if (!health.isLoading && (health.isPlaying || health.isReady)) {
        if (health.isPlaying) {
          if (!playbackStartTime) playbackStartTime = Date.now();
        }

        // Periodically ensure subtitles are enabled after the player has loaded
        if (polls % 3 === 0) {
          const subRes = await ensureSubtitlesEnabled(tabId, S && S.settings && S.settings.prefLang);
          if (subRes && subRes.clickedEnglish) {
            setStatus(`Episode ${n}: Selected English subtitles, awaiting track...`);
          }
          if (subRes && subRes.noSubtitlesAvailable) {
            return { noSubtitlesAvailable: true };
          }
        }

        // Active playback timeout: if episode has been continuously playing for > 14s without subtitles
        if (playbackStartTime && Date.now() - playbackStartTime > 14000 && health.duration > 120) {
          const subRes = await ensureSubtitlesEnabled(tabId, S && S.settings && S.settings.prefLang);
          if (subRes && subRes.noSubtitlesAvailable) {
            return { noSubtitlesAvailable: true };
          }
        }

        // Ensure video is playing if paused
        await Hud.inject(tabId, () => {
          const v = document.querySelector("video");
          if (v && v.paused && v.readyState >= 3) {
            v.muted = true;
            v.play().catch(() => {});
          }
        });
      }

      if (polls % 2 === 0) {
        await Registry.ensureTabScriptsAndScan(tabId);
      }

      polls++;
      await Config.sleep(1000);
    }
    return null;
  }

  /**
   * Execute Season Auto-Pilot Batch Pipeline.
   */
  async function runSeasonPipeline(tabId, season, S, helpers) {
    const { ledgerFor, saveState, setStatus, stopRun } = helpers;
    if (!(season > 0)) return stopRun("Enter the season number first.");
    const tab = await chrome.tabs.get(tabId);
    S.listUrl = tab.url;

    const info = await buildEpisodeMap(tabId, setStatus, S);
    if (!info.ok) return stopRun(`Couldn't read episode list. ${info.reason || ""}`);
    if (!info.complete) return stopRun(`List didn't finish expanding. Press Download again.`);

    S.map = info.map;
    S.mapSeason = season;
    const targets = Object.keys(S.map)
      .map(Number)
      .sort((a, b) => a - b);
    setStatus(`Season ${season}: ${targets.length} episodes found. Starting...`);
    await Config.sleep(1200);

    const led = ledgerFor(season, S.prefix);
    const targetExt = "." + (S.settings.exportFormat || "md").toLowerCase();
    for (let pass = 1; pass <= 3 && S.enabled; pass++) {
      const todo = targets.filter(
        (n) => !led[n] || !led[n].ok || !String(led[n].file || "").endsWith(targetExt)
      );
      if (!todo.length) break;
      if (pass > 1) {
        setStatus(`Pass ${pass} of 3: retrying ${todo.length} failed episode(s)...`);
        await Config.sleep(1500);
      }
      for (let idx = 0; idx < todo.length; idx++) {
        const n = todo[idx];
        if (!S.enabled) break;

        const usedUrls = new Set(
          Object.keys(led)
            .filter((k) => Number(k) !== n && led[k] && led[k].ok && led[k].url)
            .map((k) => led[k].url)
        );

        let sub = null;
        const alreadyHere =
          pass === 1 && idx === 0 && (await isAlreadyOnEpisode(tabId, n, S.map[n] && S.map[n].href));

        // Each episode gets up to 3 automated capture attempts per pass
        let episodeAttempts = 0;
        const maxEpAttempts = 3;

        while (episodeAttempts < maxEpAttempts && !sub && S.enabled) {
          if (S.skipRequested) break;
          episodeAttempts++;
          const t0 = Date.now();
          if (alreadyHere && episodeAttempts === 1) {
            S.currentLoadedEp = n;
            await Registry.ensureTabScriptsAndScan(tabId);
            const existingTracks = Registry.getTabTracks(tabId).filter(
              (c) =>
                !usedUrls.has(c.url) &&
                ((c.url && !String(c.url).startsWith("texttrack://")) ||
                  (Array.isArray(c.cues) && c.cues.length >= 50))
            );
            if (existingTracks.length) {
              const best = existingTracks.sort((a, b) => trackScore(b) - trackScore(a))[0];
              sub = { url: best.url, key: best.key, track: best, confirmed: true };
              break;
            }
          }

          if (!sub) {
            Registry.resetTabTracksForEpisode(tabId);
            const attemptLabel = episodeAttempts > 1 ? ` (attempt ${episodeAttempts}/${maxEpAttempts})` : "";
            setStatus(`Opening Episode ${n}: ${(S.map[n] && S.map[n].title) || ""}${attemptLabel}`);
            const opened = await openEpisode(tabId, n, S, setStatus);
            if (!opened && episodeAttempts >= maxEpAttempts) {
              led[n] = { ok: false, error: "could not open episode after 3 attempts" };
              await saveState();
              break;
            }
            setStatus(`Episode ${n}: waiting for subtitle stream${attemptLabel}...`);
            sub = await waitForSubtitle(tabId, n, t0, S, usedUrls, 35000);
            if (!sub || sub.noSubtitlesAvailable) {
              // Try switching to another server in "Servers & Mode" (e.g. Atlas <-> Vela) if current server has no working subtitles
              setStatus(`Episode ${n}: Checking alternative stream server under "Servers & Mode"...`);
              const switched = await switchToNextStreamServer(tabId);
              if (switched) {
                setStatus(`Episode ${n}: Switched server. Waiting for stream & subtitles...`);
                await Config.sleep(2500);
                await Registry.ensureTabScriptsAndScan(tabId);
                const serverSub = await waitForSubtitle(tabId, n, Date.now(), S, usedUrls, 30000);
                if (serverSub && !serverSub.noSubtitlesAvailable && !serverSub.playerCrashed) {
                  sub = serverSub;
                }
              }
            }
            if (sub && (sub.skippedByUser || sub.noSubtitlesAvailable || sub.playerCrashed)) {
              break; // Immediately exit retry loop if user skipped, platform confirmed no subtitles, or player crashed
            }
          }
        }

        if (S.skipRequested || (sub && sub.skippedByUser)) {
          S.skipRequested = false;
          led[n] = { ok: false, error: "Skipped by user" };
          await saveState();
          setStatus(`Episode ${n}: Skipped by user. Advancing to next episode...`);
          await Config.sleep(800);
          continue;
        }

        if (sub && sub.playerCrashed) {
          led[n] = { ok: false, error: "Player crashed or playback failed (tried 3 reloads)" };
          await saveState();
          setStatus(`Episode ${n}: Player crashed / playback unavailable. Advancing to next...`);
          await Config.sleep(800);
          continue;
        }

        if (sub && sub.noSubtitlesAvailable) {
          led[n] = { ok: false, error: "No subtitles available for this episode" };
          await saveState();
          setStatus(`Episode ${n}: No subtitles available on platform. Advancing to next...`);
          await Config.sleep(800);
          continue;
        }

        if (!sub) {
          led[n] = { ok: false, error: "No subtitles available for this episode (tried 3 times)" };
          await saveState();
          setStatus(`Episode ${n}: no subtitles available (tried 3 times). Advancing to next episode...`);
          await Config.sleep(1200);
          continue;
        }

        // Duplicate URL check across episodes in the same season
        let isDup = false;
        for (const k of Object.keys(led)) {
          if (Number(k) !== n && led[k].ok && led[k].url === sub.url) {
            led[n] = { ok: false, error: `same subtitle file as episode ${k}` };
            await saveState();
            setStatus(`Episode ${n}: duplicate subtitle detected, moving to next.`);
            isDup = true;
            break;
          }
        }
        if (isDup) continue;

        setStatus(`Episode ${n}: fetching subtitles...`);
        let cuesList = [];
        for (let attempt = 1; attempt <= 3; attempt++) {
          cuesList = await Registry.resolveTrackCues(S.tabId, sub.track || { url: sub.url, cues: [] });
          if (cuesList.length >= 50) break;
          await Config.sleep(1500);
        }
        if (cuesList.length < 50) {
          // If fetched subtitle file is dummy/incomplete (< 50 cues for episode), try switching server before failing
          setStatus(`Episode ${n}: Subtitle has only ${cuesList.length} cues (dummy/incomplete). Trying alternative server...`);
          const switched = await switchToNextStreamServer(S.tabId);
          if (switched) {
            await Config.sleep(2500);
            await Registry.ensureTabScriptsAndScan(S.tabId);
            const serverSub = await waitForSubtitle(S.tabId, n, Date.now(), S, usedUrls, 30000);
            if (serverSub && !serverSub.noSubtitlesAvailable && !serverSub.playerCrashed) {
              sub = serverSub;
              cuesList = await Registry.resolveTrackCues(S.tabId, sub.track || { url: sub.url, cues: [] });
            }
          }
        }
        if (cuesList.length < 50) {
          led[n] = { ok: false, error: `only ${cuesList.length} cues (dummy/incomplete subtitle)` };
          await saveState();
          setStatus(`Episode ${n}: dummy/incomplete subtitle (${cuesList.length} cues). Advancing to next...`);
          await Config.sleep(1500);
          continue;
        }

        const title = (S.map[n] && S.map[n].title) || "";
        const ext = (S.settings.exportFormat || "md").toLowerCase();
        const numStr = String(n).padStart(2, "0");
        const cleanSeries = Config.exactFileName(S.prefix, "Series");
        const seasonFolder = `Season ${S.season}`;
        const isOriginal = S.seasonNamingMode === "original";

        let fileName;
        if (isOriginal) {
          fileName = title
            ? `E${numStr} - ${Config.exactFileName(title, `Episode ${numStr}`)}.${ext}`
            : `E${numStr} - Episode ${numStr}.${ext}`;
        } else {
          fileName = `${cleanSeries} Season ${S.season} - Episode ${numStr}.${ext}`;
        }
        const relPath = `${cleanSeries}/${seasonFolder}/${fileName}`;
        const filename = Config.buildDownloadPath(relPath, S.settings.downloadFolder);

        const headingTitle =
          isOriginal && title
            ? `${cleanSeries} - Season ${S.season} Episode ${n}: ${title}`
            : `${cleanSeries} - Season ${S.season} Episode ${n}`;

        const content = Parser.formatCuesOutput(
          cuesList,
          {
            heading: headingTitle,
            sublines: [
              `**Series:** ${cleanSeries} | **Season:** ${S.season} | **Episode:** ${n}`,
              ...(title ? [`**Episode Title:** ${title}`] : [])
            ]
          },
          S.settings
        );

        const res = await Hud.downloadVerified(
          Parser.toSubtitleDataUrl(content, ext),
          filename,
          targets.length === 1 ? S.settings.saveAs : false
        );
        if (!res.ok) {
          led[n] = { ok: false, error: res.error };
          await saveState();
          setStatus(`Episode ${n}: save failed (${res.error}).`);
        } else {
          led[n] = {
            ok: true,
            file: filename,
            size: res.size,
            cues: cuesList.length,
            downloadId: res.id,
            url: sub.url,
            note: sub.confirmed ? "" : sub.note
          };
          await saveState();
          setStatus(`Saved Episode ${n} (${cuesList.length} cues).`);
        }
      }
    }

    await Hud.verifyLedgerDownloads(led);
    await saveState();

    const done = targets.filter((n) => led[n] && led[n].ok);
    const missing = targets.filter((n) => !(led[n] && led[n].ok));
    const cleanSeries = Config.exactFileName(S.prefix, "Series");
    const destDir = Config.buildDownloadPath(`${cleanSeries}/Season ${season}`, S.settings.downloadFolder);

    if (S.settings.saveReport !== false) {
      const reportMd = Parser.buildDownloadReport({
        heading: `Season ${season} Download Report`,
        totalLabel: "Episodes in list",
        totalCount: targets.length,
        savedCount: done.length,
        missingIds: missing,
        idHeader: "Episode",
        countHeader: "Cues",
        rows: targets.map((n) => {
          const r = led[n];
          return {
            id: n,
            title: (S.map[n] && S.map[n].title) || "",
            ok: !!(r && r.ok),
            size: r && r.size,
            count: r && r.cues,
            note: r && r.note,
            error: r && r.error
          };
        })
      });
      await Hud.downloadVerified(
        Parser.toSubtitleDataUrl(reportMd, "md"),
        `${destDir}/_Season_${season}_Download_Report.md`,
        false
      );
    }

    const finalSummary = missing.length
      ? `Season ${season}: ${done.length}/${targets.length} downloaded. Missing: ${missing.join(", ")}. Press 'Retry ${missing.length} Failed Episode(s)' to retry missing.`
      : `✓ Season ${season}: All ${done.length} episodes downloaded successfully to Downloads/${destDir}/`;

    stopRun(finalSummary);
  }

  root.SubSeasonPipeline = Object.freeze({
    detectActiveSeason,
    buildEpisodeMap,
    ensureSubtitlesEnabled,
    runSeasonPipeline
  });
})(self);
