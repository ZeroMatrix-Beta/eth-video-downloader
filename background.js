let videoQueue = [];
let currentVideo = null;
let currentTabId = null;
let timeoutId = null;

// Variablen für das echte Download-Limit
let maxConcurrent = 3;
let isExtracting = false;
let queueInterval = null;

// Echtzeit-Tracker für aktive Download-IDs
let activeDownloads = new Set();

// Überwacht Statusänderungen von Downloads
chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state) {
        const state = delta.state.current;
        // Sobald ein Download fertig oder abgebrochen ist, aus dem Tracker entfernen
        if (state === "complete" || state === "interrupted") {
            activeDownloads.delete(delta.id);
            // Sofort prüfen, ob das nächste Video gestartet werden kann (beschleunigt die Warteschlange)
            checkQueue();
        }
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 1. Startbefehl von der Hauptseite
    if (request.action === "start_queue") {
        videoQueue = request.queue;
        maxConcurrent = request.maxConcurrent || 3;
        activeDownloads.clear(); // Tracker zurücksetzen
        
        // Startet die regelmäßige Überprüfung
        if (!queueInterval) queueInterval = setInterval(checkQueue, 2000);
        checkQueue();
    }

    // 2. Abbruch (Stop-Button)
    if (request.action === "stop_queue") {
        videoQueue = [];
        isExtracting = false;
        activeDownloads.clear();
        if (queueInterval) {
            clearInterval(queueInterval);
            queueInterval = null;
        }
        if (timeoutId) clearTimeout(timeoutId);
        if (currentTabId) {
            chrome.tabs.remove(currentTabId);
            currentTabId = null;
        }
    }

    // 3. Link aus dem Hintergrund-Tab erhalten
    if (request.action === "link_found") {
        if (timeoutId) clearTimeout(timeoutId);
        
        chrome.downloads.download({
            url: request.url,
            filename: currentVideo.filename,
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("Download-Fehler:", chrome.runtime.lastError.message);
            } else if (downloadId !== undefined) {
                // Registriert den Download sofort, um Überschneidungen zu verhindern
                activeDownloads.add(downloadId);
            }
        });
        
        closeTabAndContinue();
    }
    
    if (request.action === "link_not_found") {
        if (timeoutId) clearTimeout(timeoutId);
        closeTabAndContinue();
    }
});

// Prüft, ob neue Downloads gestartet werden dürfen
function checkQueue() {
    // Wenn alles abgearbeitet ist
    if (videoQueue.length === 0 && !isExtracting) {
        if (queueInterval) {
            clearInterval(queueInterval);
            queueInterval = null;
        }
        chrome.tabs.query({}, function(tabs) {
            tabs.forEach(tab => {
                if (tab.url && tab.url.includes("video.ethz.ch")) {
                    chrome.tabs.sendMessage(tab.id, { action: "queue_finished" });
                }
            });
        });
        return;
    }

    // Wenn wir gerade einen Link suchen oder nichts mehr in der Warteschlange ist, abwarten
    if (isExtracting || videoQueue.length === 0) return;

    // Nutzt den präzisen lokalen Tracker statt der zeitverzögerten Chrome-Suche
    if (activeDownloads.size < maxConcurrent) {
        startExtraction();
    }
}

function startExtraction() {
    isExtracting = true;
    currentVideo = videoQueue.shift();
    
    // Auflösung als Hash mitschicken
    const tabUrl = currentVideo.url + `#eth-res=${currentVideo.res}`;
    
    chrome.tabs.create({ url: tabUrl, active: false }, (tab) => {
        currentTabId = tab.id;
        
        // Timeout: Nach 15 Sek mit dem nächsten weitermachen
        timeoutId = setTimeout(() => {
            closeTabAndContinue();
        }, 15000);
    });
}

function closeTabAndContinue() {
    if (currentTabId) {
        chrome.tabs.remove(currentTabId, () => {
            currentTabId = null;
            // Kurz warten, damit Chrome den Download registrieren kann
            setTimeout(() => {
                isExtracting = false;
                checkQueue();
            }, 1500); 
        });
    } else {
        isExtracting = false;
        checkQueue();
    }
}