// @ts-check
/**
 * Isolated-World Content Script Bridge.
 * Relays captured subtitle tracks from the MAIN-world interceptor to the background service worker,
 * and forwards in-page fetch / HLS-stitch requests from the background service worker to the MAIN world.
 */

(function () {
  if (window.__subDownloaderBridgeInstalled) return;
  window.__subDownloaderBridgeInstalled = true;

  const pendingReqs = new Map();

  window.addEventListener("message", (ev) => {
    const data = ev.data;
    if (!data || !data.__subDownloader) return;

    if (data.type === "TRACK_CAPTURED" && data.track) {
      try {
        chrome.runtime.sendMessage(
          {
            action: "reportInPageTrack",
            track: data.track,
            pageTitle: document.title || "",
            pageUrl: location.href
          },
          () => void chrome.runtime.lastError
        );
      } catch (_) {}
    } else if (data.type === "CMD_RESPONSE" && data.reqId) {
      const resolver = pendingReqs.get(data.reqId);
      if (resolver) {
        pendingReqs.delete(data.reqId);
        resolver(data);
      }
    }
  });

  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (!req || !req.bridgeCmd) return false;
    const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timeout = setTimeout(() => {
      if (pendingReqs.has(reqId)) {
        pendingReqs.delete(reqId);
        sendResponse({ ok: false, error: "timeout" });
      }
    }, req.timeoutMs || 45000);

    pendingReqs.set(reqId, (res) => {
      clearTimeout(timeout);
      sendResponse(res);
    });

    window.postMessage(
      {
        __subDownloaderCmd: true,
        reqId,
        cmd: req.bridgeCmd,
        url: req.url,
        segments: req.segments
      },
      "*"
    );
    return true;
  });
})();
