// State management helpers using chrome.storage.local
// (the service worker is suspended when idle, which would wipe in-memory state)
function updateState(changes) {
    return chrome.storage.local.set(changes);
}

function getState() {
    return chrome.storage.local.get({
        videoQueue: [],
        currentVideo: null,
        currentTabId: null,
        maxConcurrent: 3, // 0 = no limit
        isExtracting: false,
        convertTo1fps: false,
        stopped: false, // Stop was pressed: downloads still running must not report "Finished!"
        started: 0, // downloads started in this run
        failed: [], // { filename, reason } of videos skipped in this run
        // id -> { filename, convert } for every download of ours that hasn't completed yet, including
        // interrupted ones (which no longer hold a slot), so a resumed download keeps its name and conversion
        ourDownloads: {},
        conversionQueue: [], // IDs of completed downloads waiting for (or in) their 1 FPS conversion
        activeDownloads: [] // IDs of our downloads still running
    });
}

const NATIVE_HOST = "eth_video_downloader.ffmpeg";

// One port per request; an open native port also keeps the service worker alive during a long conversion.
function askNativeHost(message) {
    return new Promise((resolve) => {
        let port;
        try {
            port = chrome.runtime.connectNative(NATIVE_HOST);
        } catch (err) {
            resolve({ ok: false, error: err.message });
            return;
        }
        port.onMessage.addListener((response) => {
            resolve(response);
            port.disconnect();
        });
        port.onDisconnect.addListener(() => {
            const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Native host disconnected";
            resolve({ ok: false, error });
        });
        port.postMessage(message);
    });
}

// Converts a finished download to 1 FPS and deletes the original only once the converted file exists
async function convertDownload(downloadId) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item || !item.filename) return;

    const response = await askNativeHost({ action: "convert", path: item.filename });
    if (response.ok) {
        await chrome.downloads.removeFile(downloadId).catch(err => console.error("Could not delete original:", err.message));
    } else {
        console.error("Conversion failed, keeping original:", item.filename, response.error);
    }
}

// Runs state read-modify-write sequences one after another, so overlapping events
// (e.g. two downloads finishing at once) can't both start an extraction.
let stateLock = Promise.resolve();
function withStateLock(fn) {
    const result = stateLock.then(fn);
    stateLock = result.catch(() => {}); // keep the chain going after an error
    return result;
}

let timeoutId = null;

function removeTab(tabId) {
    // Suppress error if tab is already closed
    chrome.tabs.remove(tabId).catch(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 0. Panel asks whether the 1 FPS option can work
    if (request.action === "check_ffmpeg") {
        askNativeHost({ action: "ping" }).then((response) => {
            sendResponse({ hostInstalled: !!response.ok, ffmpeg: !!(response.ok && response.ffmpeg) });
        });
        return true; // answer asynchronously
    }

    // 1. Start command from the main page
    if (request.action === "start_queue") {
        withStateLock(() => updateState({
            videoQueue: request.queue,
            maxConcurrent: request.maxConcurrent || 0,
            convertTo1fps: !!request.convertTo1fps,
            stopped: false,
            started: 0,
            failed: [],
            isExtracting: false,
            activeDownloads: []
        })).then(checkQueue);
    }

    // 2. Stop command (Stop-Button)
    if (request.action === "stop_queue") {
        if (timeoutId) clearTimeout(timeoutId);
        withStateLock(async () => {
            const state = await getState();
            if (state.currentTabId) removeTab(state.currentTabId);

            await updateState({
                videoQueue: [],
                currentVideo: null,
                currentTabId: null,
                isExtracting: false,
                stopped: true,
                activeDownloads: []
            });
        });
    }

    // 3. Receive result from background tab
    if (request.action === "link_found" || request.action === "link_not_found") {
        finishExtraction(sender.tab && sender.tab.id, request.url, request.reason);
    }
});

// Names passed to downloads.download(), by URL: Chrome may ask for the name before the download's id
// is known and saved. Never pruned, but it only lives as long as the service worker.
const pendingNames = new Map(); // url -> filename

// Chrome forgets the filename given to downloads.download() when an interrupted download is resumed
// ("Fortsetzen") and falls back to the server's name, so hand it our name again whenever it asks.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    getState().then((state) => {
        const tracked = state.ourDownloads[item.id];
        const filename = tracked ? tracked.filename : pendingNames.get(item.url);
        if (filename) suggest({ filename, conflictAction: "uniquify" });
        else suggest();
    });
    return true; // suggest is called asynchronously
});

// Conversions run one at a time: several ffmpeg processes decoding 1080p at once only fight over the CPU.
// The queue lives in storage, so a conversion cut off by a service worker restart is simply redone.
let conversionWorker = null;
function runConversions() {
    if (conversionWorker) return;
    conversionWorker = (async () => {
        for (;;) {
            const { conversionQueue } = await getState();
            if (conversionQueue.length === 0) return;
            const downloadId = conversionQueue[0];
            await convertDownload(downloadId).catch(err => console.error("Conversion error:", err.message));
            await withStateLock(async () => {
                const state = await getState();
                await updateState({ conversionQueue: state.conversionQueue.filter(id => id !== downloadId) });
            });
        }
    })().finally(async () => {
        conversionWorker = null;
        // Something may have been queued between the last check and now
        const { conversionQueue } = await getState();
        if (conversionQueue.length > 0) runConversions();
    });
}
runConversions(); // resume after the service worker was restarted

// Event-driven queue check: frees a slot whenever one of our downloads is interrupted or completes;
// a completed one is handed to the conversion queue if the 1 FPS option was on.
// An interrupted download stays tracked, so resuming it later still converts it.
chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state) return;
    const complete = delta.state.current === "complete";
    if (!complete && delta.state.current !== "interrupted") return;

    withStateLock(async () => {
        const state = await getState();
        const tracked = state.ourDownloads[delta.id];
        const holdsSlot = state.activeDownloads.includes(delta.id);
        if (!tracked && !holdsSlot) return false;

        const cancelled = delta.error && delta.error.current === "USER_CANCELED";
        const changes = {};
        if (complete || cancelled) {
            const rest = { ...state.ourDownloads };
            delete rest[delta.id];
            changes.ourDownloads = rest;
        }
        if (complete && tracked && tracked.convert) {
            changes.conversionQueue = [...state.conversionQueue, delta.id];
        }
        if (holdsSlot) {
            changes.activeDownloads = state.activeDownloads.filter(id => id !== delta.id);
        }
        await updateState(changes);
        return true;
    }).then((wasOurs) => {
        if (!wasOurs) return;
        runConversions();
        checkQueue();
    });
});

function checkQueue() {
    return withStateLock(async () => {
        const state = await getState();

        // If the queue is finished
        if (state.videoQueue.length === 0 && !state.isExtracting) {
            if (state.stopped) return;
            const tabs = await chrome.tabs.query({});
            tabs.forEach(tab => {
                if (tab.url && tab.url.includes("video.ethz.ch")) {
                    chrome.tabs.sendMessage(tab.id, {
                        action: "queue_finished",
                        started: state.started,
                        failed: state.failed
                    }).catch(() => {});
                }
            });
            return;
        }

        if (state.isExtracting || state.videoQueue.length === 0) return;

        // Count only our own downloads, not other downloads running in the browser
        if (state.maxConcurrent && state.activeDownloads.length >= state.maxConcurrent) return;

        await startExtraction(state);
    });
}

// Must be called while holding the state lock
async function startExtraction(state) {
    const [nextVideo, ...queue] = state.videoQueue;

    await updateState({
        isExtracting: true,
        videoQueue: queue,
        currentVideo: nextVideo
    });

    const tabUrl = nextVideo.url + `#eth-res=${nextVideo.res}`;
    const tab = await chrome.tabs.create({ url: tabUrl, active: false });
    await updateState({ currentTabId: tab.id });

    // Timeout safeguard
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
        finishExtraction(tab.id, null, "timeout");
    }, 15000);
}

// Starts the download (if a link was found), closes the background tab and continues the queue
function finishExtraction(tabId, url, reason) {
    withStateLock(async () => {
        const state = await getState();

        // Ignore reports from tabs we're not waiting for (timed out, stopped, or opened by the user)
        if (!state.isExtracting || tabId !== state.currentTabId) return;
        if (timeoutId) clearTimeout(timeoutId);

        const changes = { currentTabId: null, isExtracting: false };

        if (url && state.currentVideo) {
            const filename = state.currentVideo.filename;
            pendingNames.set(url, filename);
            try {
                const downloadId = await chrome.downloads.download({
                    url: url,
                    filename: filename,
                    saveAs: false
                });
                // Register the download right away so it counts towards the limit
                changes.activeDownloads = [...state.activeDownloads, downloadId];
                changes.ourDownloads = { ...state.ourDownloads, [downloadId]: { filename, convert: state.convertTo1fps } };
                changes.started = state.started + 1;
            } catch (err) {
                console.error("Download error:", err.message);
                changes.failed = [...state.failed, { filename, reason: "download error" }];
            }
        } else if (state.currentVideo) {
            // No link found (page too slow, tab not ready...): try once more instead of silently skipping the video
            if (!state.currentVideo.retried) {
                console.warn("No download link found, retrying once:", state.currentVideo.url);
                changes.videoQueue = [{ ...state.currentVideo, retried: true }, ...state.videoQueue];
            } else {
                console.error("Giving up, no download link found:", state.currentVideo.url, reason);
                changes.failed = [...state.failed, { filename: state.currentVideo.filename, reason: reason || "timeout" }];
            }
        }

        removeTab(tabId);
        await updateState(changes);
    }).then(checkQueue);
}
