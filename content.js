// --- HILFSFUNKTIONEN FÜR DATUM UND WOCHEN ---
function getMonday(d) {
    let date = new Date(d);
    let day = date.getDay();
    let diff = date.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(date.setDate(diff)).setHours(0, 0, 0, 0);
}

function getSemesterWeek(date, minDate) {
    const mon1 = getMonday(minDate);
    const mon2 = getMonday(date);
    const diffTime = mon2 - mon1;
    const diffWeeks = Math.round(diffTime / (7 * 24 * 60 * 60 * 1000));
    return diffWeeks >= 0 ? diffWeeks + 1 : 1; 
}

function getISOWeekInfo(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function extractDateInfo(timeElement) {
    if (!timeElement) return null;
    
    let rawDate = timeElement.getAttribute('datetime'); 
    if (!rawDate) rawDate = timeElement.textContent.trim();
    if (!rawDate) return null;

    const d = new Date(rawDate);
    if (isNaN(d.getTime())) return null;

    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const year = d.getFullYear();
    
    const weekdayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const weekday = weekdayNames[d.getDay()];

    const yyyyMmDd = `${year}-${month}-${day}`;

    return {
        sortableDate: yyyyMmDd, 
        dateObj: d,
        timestamp: d.getTime(),
        month: month,
        day: day,
        year: year,
        weekday: weekday,
        calWeek: getISOWeekInfo(d)
    };
}

const currentUrl = window.location.href;

// =========================================================================
// ROLLE A: IM HINTERGRUND-TAB (Klickt den Button & sucht den Link)
// =========================================================================
if (currentUrl.includes('/v/')) {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const resolution = hashParams.get('eth-res') || '1920'; 

    const startTime = Date.now();
    let buttonClicked = false;
    let messageSent = false;

    const interval = setInterval(() => {
        if (!buttonClicked) {
            const downloadBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Download'));
            if (downloadBtn) {
                downloadBtn.click();
                buttonClicked = true;
            }
        }

        if (buttonClicked && !messageSent) {
            const allLinks = Array.from(document.querySelectorAll('a'));
            
            const preferredLink = allLinks.find(a => a.textContent.includes(resolution));
            const fullHdLink = allLinks.find(a => a.textContent.includes('1920'));
            const hdLink = allLinks.find(a => a.textContent.includes('1280'));
            const sdLink = allLinks.find(a => a.textContent.includes('640'));

            let targetUrl = preferredLink ? preferredLink.href : 
                            (fullHdLink ? fullHdLink.href : 
                            (hdLink ? hdLink.href : 
                            (sdLink ? sdLink.href : null)));

            if (targetUrl) {
                messageSent = true;
                clearInterval(interval);
                chrome.runtime.sendMessage({
                    action: "link_found",
                    url: targetUrl
                });
            }
        }

        if (Date.now() - startTime > 10000) {
            clearInterval(interval);
            if (!messageSent) {
                chrome.runtime.sendMessage({ action: "link_not_found" });
            }
        }
    }, 300);
}

// =========================================================================
// ROLLE B: AUF DER HAUPTSEITE (Link-First Smart-Crawler & UI)
// =========================================================================
else if (window === window.top && !currentUrl.includes('/v/')) {
    
    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === "queue_finished") {
            updateUIStatus("Finished!", true);
        }
    });

    function updateUIStatus(text, enableStart = false) {
        const btnStart = document.getElementById('eth-start-btn');
        if (btnStart) {
            btnStart.textContent = text;
            btnStart.disabled = !enableStart;
            btnStart.style.backgroundColor = enableStart ? "#0070bc" : "#555";
        }
        const btnStop = document.getElementById('eth-stop-btn');
        if (btnStop) {
            btnStop.disabled = enableStart;
        }
    }

    function startProcess() {
        updateUIStatus("Downloads running...", false);

        const maxInputVal = document.getElementById('eth-max-input').value;
        const maxVideos = maxInputVal ? parseInt(maxInputVal) : Infinity; 
        
        let vonDate = document.getElementById('eth-von-input').value || "0000-00-00";
        let bisDate = document.getElementById('eth-bis-input').value || "9999-99-99";
        const selectedRes = document.getElementById('eth-res-input').value;
        const weekFormat = document.getElementById('eth-week-format').value;
        const appendTitle = document.getElementById('eth-append-title').checked;

        if (vonDate > bisDate && vonDate !== "0000-00-00" && bisDate !== "9999-99-99") {
            const temp = vonDate; vonDate = bisDate; bisDate = temp;
        }

        const seenUrls = new Set();
        let extractedVideos = [];

        // 1. Alle Videos sammeln, die im gefilterten Zeitraum liegen
        const videoLinks = document.querySelectorAll('a[href*="/v/"]');
        videoLinks.forEach(linkEl => {
            if (seenUrls.has(linkEl.href)) return;

            let container = linkEl.parentElement;
            let timeEl = null;
            let titleEl = null;

            for (let i = 0; i < 8; i++) {
                if (!container) break;
                if (!timeEl) timeEl = container.querySelector('time');
                if (!titleEl) titleEl = container.querySelector('h1, h2, h3, h4, h5');
                container = container.parentElement;
            }

            if (timeEl) {
                seenUrls.add(linkEl.href);
                
                const dateInfo = extractDateInfo(timeEl);
                if (dateInfo && dateInfo.sortableDate >= vonDate && dateInfo.sortableDate <= bisDate) {
                    
                    let title = "Lecture";
                    if (titleEl && titleEl.textContent.trim().length > 0) {
                        title = titleEl.textContent.trim();
                    } else if (linkEl.textContent.trim().length > 2) {
                        title = linkEl.textContent.trim();
                    }
                    title = title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "_");

                    extractedVideos.push({
                        url: linkEl.href,
                        title: title,
                        dateInfo: dateInfo
                    });
                }
            }
        });

        // 2. Chronologisch sortieren (Älteste zuerst!)
        extractedVideos.sort((a, b) => a.dateInfo.timestamp - b.dateInfo.timestamp);

        // NEU: Wir ermitteln das absolut älteste Video der gesamten Seite als Referenz für Woche 1,
        // damit Datumsfilter die Semesterwoche nicht verfälschen.
        let absoluteMinDateObj = null;
        const allVideoLinksOnPage = document.querySelectorAll('a[href*="/v/"]');
        
        allVideoLinksOnPage.forEach(linkEl => {
            let container = linkEl.parentElement;
            let timeEl = null;
            for (let i = 0; i < 8; i++) {
                if (!container) break;
                if (!timeEl) timeEl = container.querySelector('time');
                container = container.parentElement;
            }
            if (timeEl) {
                const dateInfo = extractDateInfo(timeEl);
                if (dateInfo) {
                    if (!absoluteMinDateObj || dateInfo.timestamp < absoluteMinDateObj.getTime()) {
                        absoluteMinDateObj = dateInfo.dateObj;
                    }
                }
            }
        });

        // Fallback, falls kein Datum gefunden wurde oder die Liste leer ist
        if (!absoluteMinDateObj) {
            absoluteMinDateObj = extractedVideos.length > 0 ? extractedVideos[0].dateInfo.dateObj : new Date();
        }

        // 3. Dateinamen generieren (inklusive Unterordner)
        let currentQueue = [];

        extractedVideos.forEach(video => {
            let weekNum = video.dateInfo.calWeek;
            if (weekFormat === "semester") {
                weekNum = getSemesterWeek(video.dateInfo.dateObj, absoluteMinDateObj);
            }

            // Basis-Format: MM-DD-YYYY-weekday
            let filenameBase = `${video.dateInfo.month}-${video.dateInfo.day}-${video.dateInfo.year}-${video.dateInfo.weekday}`;

            if (weekFormat !== "none") {
                filenameBase += `-week${weekNum}`;
            }

            if (appendTitle) {
                filenameBase += `-${video.title}`;
            }

            currentQueue.push({
                url: video.url,
                // Speichert es im Vorlesungs-Unterordner
                filename: `${video.title}/${filenameBase}.mp4`,
                res: selectedRes
            });
        });

        if (currentQueue.length > 0) {
            chrome.runtime.sendMessage({ 
                action: "start_queue", 
                queue: currentQueue,
                maxConcurrent: maxVideos // An echten Download-Manager in background.js senden
            });
        } else {
            updateUIStatus("No videos found", true);
        }
    }

    function stopProcess() {
        chrome.runtime.sendMessage({ action: "stop_queue" });
        updateUIStatus("Stopped", true);
    }

    // Hilfsfunktion: Sucht die aktuellsten min/max Daten auf der Seite (nur für die UI Vorbelegung)
    function getMinMaxDates() {
        let minDate = "9999-99-99";
        let maxDate = "0000-00-00";

        const videoLinks = document.querySelectorAll('a[href*="/v/"]');
        videoLinks.forEach(linkEl => {
            let container = linkEl.parentElement;
            let timeEl = null;
            for (let i = 0; i < 8; i++) {
                if (!container) break;
                if (!timeEl) timeEl = container.querySelector('time');
                container = container.parentElement;
            }
            if (timeEl) {
                const dInfo = extractDateInfo(timeEl);
                if (dInfo) {
                    if (dInfo.sortableDate < minDate) minDate = dInfo.sortableDate;
                    if (dInfo.sortableDate > maxDate) maxDate = dInfo.sortableDate;
                }
            }
        });

        return {
            min: minDate === "9999-99-99" ? "" : minDate,
            max: maxDate === "0000-00-00" ? "" : maxDate
        };
    }

    function injectButton() {
        if (document.getElementById('eth-mini-panel')) return; // Wenn schon da, nichts tun

        const dates = getMinMaxDates();

        const panel = document.createElement('div');
        panel.id = 'eth-mini-panel';
        // Klassisches Design mit Transition für den Hide-Effekt
        panel.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 999999;
            background-color: #f4f4f4; padding: 10px; border-radius: 6px;
            box-shadow: 0 4px 10px rgba(0,0,0,0.2); border: 1px solid #ccc;
            font-family: Arial, sans-serif; font-size: 11px; color: #333;
            display: flex; flex-direction: column; width: 250px;
            transition: all 0.3s ease;
        `;

        // Der Header-Bereich inklusive dem Toggle-Button ("-")
        const header = document.createElement('div');
        header.style.cssText = "display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid #ddd;";
        header.innerHTML = `
            <div>
                <strong style="font-size: 13px; color: #0070bc;">ETH Downloader</strong>
                <span style="cursor:help; font-size: 14px; margin-left: 5px;" title="Some videos need special authorisation. Click on a video first and type in the credentials.\n\nClicking Stop doesn't stop the current download">ℹ️</span>
            </div>
            <button id="eth-toggle-btn" style="background: none; border: none; font-size: 18px; cursor: pointer; color: #555; padding: 0 4px; line-height: 1; outline: none; font-weight: bold;">−</button>
        `;

        // Ein Container, der alle Einstellungselemente umschließt
        const contentContainer = document.createElement('div');
        contentContainer.style.display = "flex";
        contentContainer.style.flexDirection = "column";
        contentContainer.style.gap = "6px";

        const row1 = document.createElement('div');
        row1.style.display = "flex"; row1.style.justifyContent = "space-between"; row1.style.alignItems = "center";
        row1.innerHTML = `<b>Max at once:</b> <input type="number" id="eth-max-input" placeholder="All" value="3" min="1" style="width: 45px; font-size: 11px; padding: 3px; border: 1px solid #ccc; border-radius: 3px; text-align: center;">`;

        const row2 = document.createElement('div');
        row2.style.display = "flex"; row2.style.justifyContent = "space-between"; row2.style.alignItems = "center";
        row2.innerHTML = `<b>From:</b> <input type="date" id="eth-von-input" value="${dates.min}" style="font-size: 11px; padding: 3px; width: 115px; border: 1px solid #ccc; border-radius: 3px;">`;

        const row3 = document.createElement('div');
        row3.style.display = "flex"; row3.style.justifyContent = "space-between"; row3.style.alignItems = "center";
        row3.innerHTML = `<b>To:</b> <input type="date" id="eth-bis-input" value="${dates.max}" style="font-size: 11px; padding: 3px; width: 115px; border: 1px solid #ccc; border-radius: 3px;">`;

        const rowRes = document.createElement('div');
        rowRes.style.display = "flex"; rowRes.style.justifyContent = "space-between"; rowRes.style.alignItems = "center";
        rowRes.innerHTML = `<b>Quality:</b> 
            <select id="eth-res-input" style="font-size: 11px; padding: 3px; width: 123px; border: 1px solid #ccc; border-radius: 3px; cursor: pointer;">
                <option value="1920">1080p (High)</option>
                <option value="1280">720p (Medium)</option>
                <option value="640">360p (Low)</option>
            </select>`;

        const rowWeek = document.createElement('div');
        rowWeek.style.display = "flex"; rowWeek.style.justifyContent = "space-between"; rowWeek.style.alignItems = "center";
        rowWeek.innerHTML = `<b>Week format:</b> 
            <select id="eth-week-format" style="font-size: 11px; padding: 3px; width: 123px; border: 1px solid #ccc; border-radius: 3px; cursor: pointer;">
                <option value="none">Don't include week</option>
                <option value="calendar">Calendar Week</option>
                <option value="semester">Start at Week 1</option>
            </select>`;

        const rowTitle = document.createElement('div');
        rowTitle.style.display = "flex"; rowTitle.style.justifyContent = "space-between"; rowTitle.style.alignItems = "center";
        rowTitle.innerHTML = `<label for="eth-append-title" style="cursor:pointer;"><b>Append course title:</b></label> 
            <input type="checkbox" id="eth-append-title" checked style="cursor: pointer; transform: scale(1.1);">`;

        const btnContainer = document.createElement('div');
        btnContainer.style.display = "flex"; btnContainer.style.gap = "5px"; btnContainer.style.marginTop = "4px";

        const btnStart = document.createElement('button');
        btnStart.id = 'eth-start-btn';
        btnStart.textContent = "Start";
        btnStart.style.cssText = "flex: 1; padding: 7px; background-color: #0070bc; color: white; border: none; border-radius: 4px; font-size: 12px; cursor: pointer; font-weight: bold; transition: background-color 0.2s;";
        btnStart.onclick = startProcess;
        btnStart.onmouseover = () => { if(!btnStart.disabled) btnStart.style.backgroundColor = "#00558f"; };
        btnStart.onmouseout = () => { if(!btnStart.disabled) btnStart.style.backgroundColor = "#0070bc"; };

        const btnStop = document.createElement('button');
        btnStop.id = 'eth-stop-btn';
        btnStop.textContent = "Stop";
        btnStop.disabled = true;
        btnStop.style.cssText = "flex: 1; padding: 7px; background-color: #d32f2f; color: white; border: none; border-radius: 4px; font-size: 12px; cursor: pointer; font-weight: bold; transition: background-color 0.2s;";
        btnStop.onclick = stopProcess;

        // Toggle-Logik (Ausklappen/Zuklappen)
        const toggleBtn = header.querySelector('#eth-toggle-btn');
        let isMinimized = false;
        toggleBtn.onclick = () => {
            isMinimized = !isMinimized;
            if (isMinimized) {
                contentContainer.style.display = 'none';
                toggleBtn.textContent = '+';
                header.style.marginBottom = '0';
                header.style.borderBottom = 'none';
                panel.style.width = '180px';
            } else {
                contentContainer.style.display = 'flex';
                toggleBtn.textContent = '−';
                header.style.marginBottom = '6px';
                header.style.borderBottom = '1px solid #ddd';
                panel.style.width = '250px';
            }
        };

        btnContainer.appendChild(btnStart);
        btnContainer.appendChild(btnStop);

        contentContainer.appendChild(row1);
        contentContainer.appendChild(row2);
        contentContainer.appendChild(row3);
        contentContainer.appendChild(rowRes);
        contentContainer.appendChild(rowWeek);
        contentContainer.appendChild(rowTitle);
        contentContainer.appendChild(btnContainer);
        
        panel.appendChild(header);
        panel.appendChild(contentContainer);
        document.body.appendChild(panel);
    }

    // KUGELSICHER: Prüft alle 1,5 Sekunden.
    setInterval(() => {
        if (!document.getElementById('eth-mini-panel')) {
            injectButton();
        } else {
            // Aktualisiert die Datums-Felder dynamisch, falls die Seite die Videos erst später nachgeladen hat!
            const vonInput = document.getElementById('eth-von-input');
            const bisInput = document.getElementById('eth-bis-input');
            
            if (vonInput && bisInput && (!vonInput.value || !bisInput.value)) {
                const dates = getMinMaxDates();
                if (!vonInput.value && dates.min) vonInput.value = dates.min;
                if (!bisInput.value && dates.max) bisInput.value = dates.max;
            }
        }
    }, 1500);
}