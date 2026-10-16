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
        activeDownloads: [] // IDs of downloads started by this extension that are still running
    });
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

chrome.runtime.onMessage.addListener((request, sender) => {
    // 1. Start command from the main page
    if (request.action === "start_queue") {
        withStateLock(() => updateState({
            videoQueue: request.queue,
            maxConcurrent: request.maxConcurrent || 0,
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
                activeDownloads: []
            });
        });
    }

    // 3. Receive result from background tab
    if (request.action === "link_found" || request.action === "link_not_found") {
        finishExtraction(sender.tab && sender.tab.id, request.url);
    }
});

// Event-driven queue check: frees a slot whenever one of our downloads completes or fails
chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
        withStateLock(async () => {
            const state = await getState();
            if (!state.activeDownloads.includes(delta.id)) return false;
            await updateState({ activeDownloads: state.activeDownloads.filter(id => id !== delta.id) });
            return true;
        }).then((wasOurs) => {
            if (wasOurs) checkQueue();
        });
    }
});

function checkQueue() {
    return withStateLock(async () => {
        const state = await getState();

        // If the queue is finished
        if (state.videoQueue.length === 0 && !state.isExtracting) {
            const tabs = await chrome.tabs.query({});
            tabs.forEach(tab => {
                if (tab.url && tab.url.includes("video.ethz.ch")) {
                    chrome.tabs.sendMessage(tab.id, { action: "queue_finished" }).catch(() => {});
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
        finishExtraction(tab.id, null);
    }, 15000);
}

// Starts the download (if a link was found), closes the background tab and continues the queue
function finishExtraction(tabId, url) {
    withStateLock(async () => {
        const state = await getState();

        // Ignore reports from tabs we're not waiting for (timed out, stopped, or opened by the user)
        if (!state.isExtracting || tabId !== state.currentTabId) return;
        if (timeoutId) clearTimeout(timeoutId);

        const changes = { currentTabId: null, isExtracting: false };

        if (url && state.currentVideo) {
            try {
                const downloadId = await chrome.downloads.download({
                    url: url,
                    filename: state.currentVideo.filename,
                    saveAs: false
                });
                // Register the download right away so it counts towards the limit
                changes.activeDownloads = [...state.activeDownloads, downloadId];
            } catch (err) {
                console.error("Download error:", err.message);
            }
        } else if (state.currentVideo) {
            // No link found (page too slow, tab not ready...): try once more instead of silently skipping the video
            if (!state.currentVideo.retried) {
                console.warn("No download link found, retrying once:", state.currentVideo.url);
                changes.videoQueue = [{ ...state.currentVideo, retried: true }, ...state.videoQueue];
            } else {
                console.error("Giving up, no download link found:", state.currentVideo.url);
            }
        }

        removeTab(tabId);
        await updateState(changes);
    }).then(checkQueue);
}
