// --- HILFSFUNKTIONEN FÜR DATUM UND WOCHEN ---
function getMonday(d) {
    let date = new Date(d);
    let day = date.getDay();
    let diff = date.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(date.setDate(diff)).setHours(0, 0, 0, 0);
}

// Counts only weeks that have recordings, so breaks (e.g. Easter) don't use up a week number.
// lectureWeeks: sorted Monday timestamps of all weeks with a recording on the page.
function getSemesterWeek(date, lectureWeeks) {
    const index = lectureWeeks.indexOf(getMonday(date));
    return index >= 0 ? index + 1 : 1;
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

// After the extension is reloaded or updated, scripts in tabs that were already open lose their
// connection and chrome.runtime is gone, so sending a message throws instead of failing quietly.
function extensionAlive() {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
}

// Videos live under ".../v/<id>" inside a lecture page, or "/!v/<id>" on a directly opened series ("/!s/<id>")
const VIDEO_LINK_SELECTOR = 'a[href*="/v/"], a[href*="/!v/"]';
const isVideoPage = /\/!?v\//.test(window.location.pathname);

// =========================================================================
// ROLLE A: IM HINTERGRUND-TAB (Klickt den Button & sucht den Link)
// =========================================================================
if (isVideoPage) {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const resolution = hashParams.get('eth-res') || '1920'; 

    const startTime = Date.now();
    let buttonClicked = false;
    let messageSent = false;

    const interval = setInterval(() => {
        if (!extensionAlive()) {
            clearInterval(interval);
            return;
        }

        if (!buttonClicked) {
            // Find both English "Download" and German "Herunterladen" buttons
            const downloadBtn = Array.from(document.querySelectorAll('button')).find(b => {
                const text = b.textContent.toLowerCase();
                return text.includes('download') || text.includes('herunterladen');
            });
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
                // A password form instead of the player means this tab has no unlock for the video
                let reason = "no links";
                if (!buttonClicked) {
                    reason = document.querySelector('input[type="password"]') ? "locked" : "no download button";
                }
                chrome.runtime.sendMessage({ action: "link_not_found", reason: reason });
            }
        }
    }, 300);
}

// =========================================================================
// ROLLE B: AUF DER HAUPTSEITE (Link-First Smart-Crawler & UI)
// =========================================================================
else if (window === window.top) {

    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === "queue_finished") {
            updateUIStatus("Finished!", true);
            showRunSummary(request.started || 0, request.failed || []);
        }
    });

    // "Finished!" alone hides videos that were skipped, so list how many and why
    function showRunSummary(started, failed) {
        const summary = document.getElementById('eth-run-summary');
        if (!summary) return;
        let text = `${started} download${started === 1 ? "" : "s"} started`;
        summary.style.color = "#333";
        summary.title = "";
        if (failed.length > 0) {
            const reasons = {};
            failed.forEach(f => { reasons[f.reason] = (reasons[f.reason] || 0) + 1; });
            text += `, ${failed.length} failed (` + Object.entries(reasons).map(([r, n]) => `${n} ${r}`).join(", ") + ")";
            if (reasons.locked) text += ". Locked: unlock a video of the series while signed in to ETH, then retry.";
            summary.style.color = "#d32f2f";
            summary.title = failed.map(f => `${f.reason}: ${f.filename}`).join("\n");
        }
        summary.textContent = text;
        summary.style.display = 'block';
    }

    function updateUIStatus(text, enableStart = false, stopText = "Stop") {
        const btnStart = document.getElementById('eth-start-btn');
        if (btnStart) {
            btnStart.textContent = text;
            btnStart.disabled = !enableStart;
            btnStart.style.backgroundColor = enableStart ? "#0070bc" : "#555";
        }
        const btnStop = document.getElementById('eth-stop-btn');
        if (btnStop) {
            btnStop.disabled = enableStart;
            btnStop.textContent = stopText;
        }
    }

    function startProcess() {
        if (!extensionAlive()) {
            updateUIStatus("Reload the page", true);
            return;
        }

        // An unfinished date (e.g. only the day typed) reads as "" and would silently mean "no limit"
        const dateInputs = [document.getElementById('eth-von-input'), document.getElementById('eth-bis-input')];
        if (dateInputs.some(input => input.validity.badInput)) {
            updateUIStatus("Check dates", true);
            return;
        }

        updateUIStatus("Downloads running...", false);
        const oldSummary = document.getElementById('eth-run-summary');
        if (oldSummary) oldSummary.style.display = 'none';

        const maxInputVal = document.getElementById('eth-max-input').value;
        // 0 = no limit (Infinity doesn't survive being sent as a message)
        const maxVideos = maxInputVal ? parseInt(maxInputVal) : 0;
        
        let vonDate = document.getElementById('eth-von-input').value || "0000-00-00";
        let bisDate = document.getElementById('eth-bis-input').value || "9999-99-99";
        const selectedRes = document.getElementById('eth-res-input').value;
        const weekFormat = document.getElementById('eth-week-format').value;
        const appendTitle = document.getElementById('eth-append-title').checked;
        const convertTo1fps = document.getElementById('eth-convert-1fps').checked;

        if (vonDate > bisDate && vonDate !== "0000-00-00" && bisDate !== "9999-99-99") {
            const temp = vonDate; vonDate = bisDate; bisDate = temp;
        }

        const seenUrls = new Set();
        let extractedVideos = [];

        // 1. Alle Videos sammeln
        const videoLinks = document.querySelectorAll(VIDEO_LINK_SELECTOR);
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

        // Collect the weeks with recordings across the whole page (not just the date range),
        // so the date filter doesn't shift the semester week numbers.
        const lectureMondays = new Set();
        videoLinks.forEach(linkEl => {
            let container = linkEl.parentElement;
            let timeEl = null;
            for (let i = 0; i < 8; i++) {
                if (!container) break;
                if (!timeEl) timeEl = container.querySelector('time');
                container = container.parentElement;
            }
            if (timeEl) {
                const dateInfo = extractDateInfo(timeEl);
                if (dateInfo) lectureMondays.add(getMonday(dateInfo.dateObj));
            }
        });
        const lectureWeeks = [...lectureMondays].sort((a, b) => a - b);

        // 3. Dateinamen generieren (inklusive Unterordner)
        let currentQueue = [];

        extractedVideos.forEach(video => {
            let weekNum = video.dateInfo.calWeek;
            if (weekFormat === "semester") {
                weekNum = getSemesterWeek(video.dateInfo.dateObj, lectureWeeks);
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
                filename: `${video.title}/${filenameBase}.mp4`,
                res: selectedRes
            });
        });

        if (currentQueue.length > 0) {
            chrome.runtime.sendMessage({ 
                action: "start_queue", 
                queue: currentQueue,
                maxConcurrent: maxVideos,
                convertTo1fps: convertTo1fps
            });
        } else {
            updateUIStatus("No videos found", true);
        }
    }

    function stopProcess() {
        chrome.runtime.sendMessage({ action: "stop_queue" });
        updateUIStatus("Start", true, "Stopped");
    }

    // Finds the oldest and newest video dates on the page (used to prefill the UI)
    function getMinMaxDates() {
        let minDate = "9999-99-99";
        let maxDate = "0000-00-00";

        const videoLinks = document.querySelectorAll(VIDEO_LINK_SELECTOR);
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
        if (document.getElementById('eth-mini-panel')) return;

        const dates = getMinMaxDates();

        const panel = document.createElement('div');
        panel.id = 'eth-mini-panel';
        // Solid design (restored dated style layout)
        panel.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 999999;
            background-color: #f4f4f4; padding: 10px; border-radius: 6px;
            box-shadow: 0 4px 10px rgba(0,0,0,0.2); border: 1px solid #ccc;
            font-family: Arial, sans-serif; font-size: 11px; color: #333;
            display: flex; flex-direction: column; width: 250px;
            transition: all 0.3s ease;
        `;

        const header = document.createElement('div');
        header.style.cssText = "display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid #ddd;";
        header.innerHTML = `
            <div>
                <strong style="font-size: 13px; color: #0070bc;">ETH Downloader</strong>
                <span style="cursor:help; font-size: 14px; margin-left: 5px;" title="Some videos need special authorisation. Click on a video first and type in the credentials.&#10;&#10;Clicking Stop doesn't stop the current download">ℹ️</span>
            </div>
            <button id="eth-toggle-btn" style="background: none; border: none; font-size: 18px; cursor: pointer; color: #555; padding: 0 4px; line-height: 1; outline: none; font-weight: bold;">−</button>
        `;

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

        // Mark manual edits so the periodic refresh never overwrites them
        [row2, row3].forEach(row => {
            const input = row.querySelector('input');
            ['input', 'change'].forEach(ev => input.addEventListener(ev, () => { input.dataset.edited = "1"; }));
        });

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

        const rowConvert = document.createElement('div');
        rowConvert.style.display = "flex"; rowConvert.style.flexDirection = "column";
        rowConvert.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <label for="eth-convert-1fps" style="cursor:pointer;" title="After each download, ffmpeg re-encodes it to 1 FPS with mono AAC audio (-speed-1-compressed.mp4) and deletes the original. The original is kept if the conversion fails."><b>Convert to 1 FPS (ffmpeg):</b></label>
                    <span id="eth-convert-help" style="cursor: help; display: inline-block; width: 13px; height: 13px; line-height: 13px; margin-left: 3px; border-radius: 50%; background: #888; color: white; font-size: 9px; font-weight: bold; text-align: center;">?</span>
                </div>
                <input type="checkbox" id="eth-convert-1fps" style="cursor: pointer; transform: scale(1.1);">
            </div>
            <span id="eth-convert-status" style="color: #d32f2f; font-size: 10px; display: none;"></span>`;

        // Steps for the viewer's system; the extension's real ID goes into the command, only the folder is a placeholder
        const isWindows = /Windows/.test(navigator.userAgent);
        const isMac = /Mac OS X|Macintosh/.test(navigator.userAgent);
        const installer = isWindows ? "native-host\\install.ps1" : "native-host/install.sh";
        rowConvert.querySelector('#eth-convert-help').title = (isWindows ? [
            "One-time setup (needs ffmpeg on PATH, e.g. winget install Gyan.FFmpeg):",
            "",
            "1. Run in PowerShell:",
            `powershell -ExecutionPolicy Bypass -File "<extension folder>\\native-host\\install.ps1" -ExtensionId ${chrome.runtime.id}`,
            "",
            "   <extension folder> is the folder loaded in chrome://extensions,",
            "   e.g. C:\\Users\\<you>\\...\\ETH Video Downloader",
            "",
            "2. Restart Chrome completely (also from the system tray).",
            "",
            "To remove it: same command with -Uninstall instead of -ExtensionId ..."
        ] : [
            `One-time setup (needs ffmpeg and python3, e.g. ${isMac ? "brew install ffmpeg" : "sudo apt install ffmpeg python3"}):`,
            "",
            "1. Run in a terminal:",
            `bash "<extension folder>/native-host/install.sh" ${chrome.runtime.id}`,
            "",
            "   <extension folder> is the folder loaded in chrome://extensions,",
            `   e.g. ${isMac ? "/Users/<you>" : "/home/<you>"}/.../ETH Video Downloader`,
            "",
            `2. Quit the browser completely${isMac ? " (Cmd+Q)" : ""} and start it again.`,
            "",
            "To remove it: same command with --uninstall instead of the ID"
        ]).join("\n");

        // Only lets the option stay on if the native host and ffmpeg are actually there
        const convertBox = rowConvert.querySelector('#eth-convert-1fps');
        const convertStatus = rowConvert.querySelector('#eth-convert-status');
        convertBox.addEventListener('change', () => {
            convertStatus.style.display = 'none';
            if (!convertBox.checked) return;
            if (!extensionAlive()) {
                convertBox.checked = false;
                convertStatus.textContent = "Reload the page";
                convertStatus.style.display = 'block';
                return;
            }
            chrome.runtime.sendMessage({ action: "check_ffmpeg" }, (result) => {
                if (result && result.ffmpeg) return;
                convertBox.checked = false;
                convertStatus.textContent = result && result.hostInstalled
                    ? "ffmpeg not found on PATH (restart Chrome after installing it)"
                    : `Helper not installed: run ${installer} (see ?)`;
                convertStatus.style.display = 'block';
            });
        });

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

        // Toggle logic (Collapse/Expand)
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

        // Subtle hidden button to hide/show the entire UI panel
        // (replace any leftover one, since it belongs to the old panel)
        const oldHideShowBtn = document.getElementById('eth-visibility-toggle');
        if (oldHideShowBtn) oldHideShowBtn.remove();
        const hideShowBtn = document.createElement('button');
        hideShowBtn.id = 'eth-visibility-toggle';
        hideShowBtn.style.cssText = `
            position: fixed; bottom: 5px; right: 5px; z-index: 1000000;
            width: 10px; height: 10px; border-radius: 50%;
            background-color: rgba(120, 120, 120, 0.4); border: none;
            cursor: pointer; opacity: 0.1; transition: opacity 0.2s;
            outline: none; padding: 0; margin: 0;
        `;
        hideShowBtn.title = "Toggle ETH Downloader UI Visibility";
        hideShowBtn.onmouseover = () => hideShowBtn.style.opacity = "0.7";
        hideShowBtn.onmouseout = () => hideShowBtn.style.opacity = "0.1";
        
        hideShowBtn.onclick = () => {
            if (panel.style.display === 'none') {
                panel.style.display = 'flex';
            } else {
                panel.style.display = 'none';
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
        contentContainer.appendChild(rowConvert);
        contentContainer.appendChild(btnContainer);

        const runSummary = document.createElement('div');
        runSummary.id = 'eth-run-summary';
        runSummary.style.cssText = "display: none; font-size: 10px; cursor: help;";
        contentContainer.appendChild(runSummary);
        
        panel.appendChild(header);
        panel.appendChild(contentContainer);
        
        document.body.appendChild(panel);
        document.body.appendChild(hideShowBtn);
    }

    // Keeps the From/To fields in sync with the videos on the page (they load late, and the
    // page is a single-page app, so the panel survives switching to another course).
    // A field the user is editing is left alone: an unfinished date input has value "",
    // which would otherwise be reset to the first/last date in the middle of typing.
    let lastPath = location.pathname;
    function syncDateInputs() {
        const vonInput = document.getElementById('eth-von-input');
        const bisInput = document.getElementById('eth-bis-input');
        if (!vonInput || !bisInput) return;

        // New course: forget manual edits and take over its dates
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            delete vonInput.dataset.edited;
            delete bisInput.dataset.edited;
        }

        const dates = getMinMaxDates();
        [[vonInput, dates.min], [bisInput, dates.max]].forEach(([input, value]) => {
            if (input.dataset.edited || document.activeElement === input) return;
            if (input.value !== value) input.value = value;
        });
    }

    // Checks every 1.5s, so the panel survives the page re-rendering or loading content late
    setInterval(() => {
        if (!document.getElementById('eth-mini-panel')) {
            injectButton();
        } else {
            syncDateInputs();
        }
    }, 1500);
}