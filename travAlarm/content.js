/**
 * TRAVIAN WATCHMAN PRO - CONTENT SCRIPT
 * Version: 1.9 (Stable / Descriptors Optimized / Hero Server Lock)
 */

// ==========================================
// CONFIGURATION & STATE
// ==========================================
let lastNamesKey = "";
let silencedAlarms = new Set();
let localTracked = new Set();
let currentAlarms = [];
const uiRefs = new Map();

// Throttle Flag (Jitter Fix)
let isScanning = false;

// Server Tag - Essential for multi-server isolation
const serverTag = `[${window.location.hostname.split('.')[0]}]`;

const DEFAULT_SHORTCUTS = [
    { label: "15m", minutes: 15, isRecurring: false },
    { label: "30m", minutes: 30, isRecurring: false }
];

// Helper: Cleans text strings
const cleanText = (str) => str.replace(/\s+/g, ' ').trim();
const cleanCoords = (str) => str.replace(/[^\d|−-]/g, '').replace('−', '-');

// ==========================================
// CORE LOGIC: SCANNERS
// ==========================================

function scan() {
    // 1. Throttling: Prevent execution more than once every 500ms
    if (isScanning) return;
    isScanning = true;
    setTimeout(() => { isScanning = false; }, 500);

    // 2. Map Awareness: Hide widget on fullscreen map
    if (typeof timerWidget !== 'undefined' && timerWidget) {
        const isMap = window.location.pathname.includes('karte.php');
        const isFull = new URLSearchParams(window.location.search).get('fullscreen') === '1';
        timerWidget.style.display = (isMap && isFull) ? 'none' : '';
    }

    try {
        const villageMap = scanVillages(); // Scans sidebar for coords -> name mapping
        const activeVillage = getActiveVillageName();
        const found = [];

        // 3. Scan Buildings with Safe-Fail Logic
        let matchedBuildingIds = null; 
        
        try {
            const scanResult = scanBuildings(activeVillage);
            if (scanResult !== null) {
                found.push(...scanResult.newBuildings);
                matchedBuildingIds = scanResult.matchedIds;
            }
        } catch (e) { console.error("Building Scan Error:", e); }

        // 4. Scan Hero (Optimized for one alarm per server)
        try {
            const heroStatuses = scanHero(activeVillage, villageMap);
            if (heroStatuses && heroStatuses.length > 0) {
                found.push(...heroStatuses); 
            }
        } catch (e) { console.error("Hero Scan Error:", e); }

        // 5. Scan Incoming Attacks
        try {
            const attacks = scanAttacks(activeVillage);
            if (attacks.length > 0) found.push(...attacks);
        } catch (e) { console.error("Attack Scan Error:", e); }

        // 6. Conditional Cleanup: Abort if list was missing to prevent flicker
        if (matchedBuildingIds !== null) {
            handleQueueCleanup(matchedBuildingIds, activeVillage);
        }

        // 7. Update Backend
        if (found.length > 0) {
            browser.runtime.sendMessage({ type: "REFRESH_ALARMS", buildings: found });
        }

        if (typeof scanResources === "function") scanResources(activeVillage);
        
    } catch (err) {
        console.error("Watchman Main Loop Error:", err);
    }
}

/**
 * Scans Hero Status and cross-references coordinates with the village list.
 * Effectively enforces a "One Hero Alarm Per Server" rule.
 */
function scanHero(activeVillage, villageMap) {
    const heroTimers = document.querySelectorAll('.heroStatus .timer, #sidebarBoxHero .timer, .tippy-content .timer, #travian_tooltip .timer');
    if (!heroTimers || heroTimers.length === 0) return [];

    const foundHeroes = [];

    heroTimers.forEach(heroTimer => {
        const parent = heroTimer.closest('.heroStatus, #sidebarBoxHero, .tippy-content, #travian_tooltip');
        if (!parent) return;

        const rawStatus = parent.querySelector('.text')?.innerText || "";
        const rawStatusLower = rawStatus.toLowerCase();
        
        // User requested -2000ms offset for Hero alarms
        const delayValue = ((heroTimer.getAttribute('value') | 0) * 1000) - 2000;
        const scheduledTime = Date.now() + delayValue;
        
        if (delayValue <= 0) return;

        // Cross-reference tooltip coordinates with Sidebar Village List
        const coordMatch = rawStatus.match(/\([−-]?\d+[|/][−-]?\d+\)/);
        let matchedVillageName = "";
        if (coordMatch) {
            const key = cleanCoords(coordMatch[0]);
            matchedVillageName = villageMap[key];
        }

        // Identify the Hero's origin village from the tooltip link
        const homeLink = parent.querySelector('a[href*="id="]');
        let originName = homeLink ? cleanText(homeLink.innerText.split('\n')[0]) : (activeVillage || "Home Village");

        let actionLabel = "";
        let targetName = "";

        if (rawStatusLower.includes("oasis")) {
            actionLabel = "Going to Oasis";
            targetName = originName; // Display source village
        } else if (rawStatusLower.includes("adventure")) {
            actionLabel = "Going to Adventure";
            targetName = originName; // Display source village
        } else if (rawStatusLower.includes("reinforce")) {
            actionLabel = "Reinforcing";
            targetName = matchedVillageName || (coordMatch ? coordMatch[0] : originName);
        } else {
            actionLabel = "Returning to";
            targetName = matchedVillageName || (coordMatch ? coordMatch[0] : originName);
        }

        const heroName = cleanText(`⚔️ ${actionLabel} | ${targetName} ${serverTag}`);
        
        // SERVER LOCK: Abort if any hero alarm for this server tag already exists
        const serverHeroExists = currentAlarms.some(a => 
            a.name.includes("⚔️") && 
            a.name.includes(serverTag) &&
            Math.abs(a.scheduledTime - scheduledTime) < 30000 // 30s drift buffer
        );

        if (!serverHeroExists && !localTracked.has(heroName)) {
            localTracked.add(heroName);
            foundHeroes.push({ name: heroName, delay: delayValue });
        }
    });

    return foundHeroes;
}

// ... rest of your functions (scanVillages, scanBuildings, handleQueueCleanup, etc.) remain as provided in version 1.8

function scanVillages() {
    const map = {};
    const items = document.querySelectorAll('.villageList li, .villageList .listEntry');
    items.forEach(item => {
        const nameNode = item.querySelector('.name');
        const coordNode = item.querySelector('.coordinates.coordinatesWrapper') || item.querySelector('.coordinatesGrid .coordinatesWrapper');
        if (nameNode && coordNode) {
            const vName = cleanText(nameNode.innerText);
            const key = cleanCoords(coordNode.innerText.trim());
            map[key] = vName;
        }
    });
    return map;
}

function getActiveVillageName() {
    const activeNode = document.querySelector('.villageList .active .name') || document.querySelector('#sidebarBoxVillagelist .active .name');
    return activeNode ? cleanText(activeNode.innerText) : "Village";
}

function scanBuildings(activeVillage) {
    const buildingList = document.querySelector('.buildingList');
    if (!buildingList) return null; 

    const rows = buildingList.querySelectorAll('li, tr');
    const now = Date.now();
    const rawBuildings = [];

    rows.forEach(row => {
        const t = row.querySelector('.timer');
        if (!t || row.classList.contains('masterBuilder')) return;
        
        const txt = row.innerText;
        const match = txt.match(/(.*?)\s+Level\s+(\d+)/i);
        const bName = match ? cleanText(match[1]) : cleanText(txt.split('Level')[0]);
        const bLevel = match ? match[2].trim() : "";
        const delayValue = ((t.getAttribute('value') | 0) * 1000) + 1700;
        
        rawBuildings.push({
            bName: bName, 
            bLevel: bLevel,
            baseName: `${bName} lvl ${bLevel} (${activeVillage}) ${serverTag}`,
            delay: delayValue,
            scheduledTime: now + delayValue
        });
    });

    rawBuildings.sort((a, b) => a.scheduledTime - b.scheduledTime);

    const nameCounts = {};
    const processedBuildings = rawBuildings.map(b => {
        if (!nameCounts[b.baseName]) nameCounts[b.baseName] = 0;
        nameCounts[b.baseName]++;
        let finalName = b.baseName;
        if (nameCounts[b.baseName] > 1) {
            finalName = `${b.baseName} #${nameCounts[b.baseName]}`;
        }
        return { ...b, name: finalName };
    });

    const newAlarms = [];
    const matchedIds = new Set();
    const usedAlarmIds = new Set(); 

    processedBuildings.forEach(pb => {
        const bestMatch = currentAlarms.find(a => {
            if (usedAlarmIds.has(a.id || a.name)) return false; 
            const timeDiff = Math.abs(a.scheduledTime - pb.scheduledTime);
            if (timeDiff > 20000) return false; 
            if (a.name.startsWith(pb.baseName)) return true;
            const looseStart = `${pb.bName} lvl `;
            const looseEnd = `(${activeVillage}) ${serverTag}`;
            if (a.name.startsWith(looseStart) && a.name.includes(looseEnd)) return true;
            return false;
        });

        if (bestMatch) {
            const uid = bestMatch.id || bestMatch.name;
            matchedIds.add(uid);
            usedAlarmIds.add(uid);
            if (bestMatch.name !== pb.name) {
                bestMatch.name = pb.name; 
                browser.runtime.sendMessage({ type: "EDIT_ALARM", id: bestMatch.id, newName: pb.name });
            }
        } else {
            newAlarms.push({ name: pb.name, delay: pb.delay });
        }
    });

    return { newBuildings: newAlarms, matchedIds };
}

function handleQueueCleanup(matchedIds, activeVillage) {
    const now = Date.now();
    currentAlarms.forEach(a => {
        if (a.name.includes('⚠️') || a.name.includes('⚔️') || a.name.includes('⭐')) return;
        const vTag = `(${activeVillage})`;
        if (!a.name.includes(vTag) || !a.name.includes(serverTag)) return;
        if (matchedIds.has(a.id || a.name)) return;
        const timeRemaining = a.scheduledTime - now;
        if (timeRemaining > 10000) {
            browser.runtime.sendMessage({ type: "DELETE_ALARM", id: a.id, name: a.name });
        }
    });
}

function scanAttacks(activeVillage) {
    const p = new URLSearchParams(window.location.search);
    if (p.get('gid') !== '16' || p.get('tt') !== '1' || p.get('filter') !== '1' || p.get('subfilters') !== '1') {
        return [];
    }
    const buildDiv = document.getElementById('build');
    if (!buildDiv) return [];
    const attacksOnScreen = [];
    const found = [];
    const now = Date.now();
    const timers = buildDiv.querySelectorAll('.timer, [id^="timer"]');
    timers.forEach(t => {
        const row = t.closest('tr') || t.closest('.troop_details');
        if (!row) return;
        const html = row.innerHTML;
        const text = row.innerText.toLowerCase();
        const isReturn = text.includes('return') || html.includes('def3');
        if (!isReturn) {
            let type = text.includes('raid') ? "Raid" : "Attack";
            const coordMatch = text.match(/\([−-]?\d+[|/][−-]?\d+\)/);
            const targetStr = coordMatch ? coordMatch[0] : activeVillage;
            const baseName = cleanText(`⚠️${type} | ${targetStr} ${serverTag}`);
            const delayValue = ((t.getAttribute('value') | 0) * 1000) + 1700;
            if (delayValue > 0) {
                attacksOnScreen.push({
                    baseName: baseName,
                    delay: delayValue,
                    scheduledTime: now + delayValue
                });
            }
        }
    });
    const groups = {};
    attacksOnScreen.forEach(a => {
        if (!groups[a.baseName]) groups[a.baseName] = [];
        groups[a.baseName].push(a);
    });
    for (const baseName in groups) {
        let items = groups[baseName];
        const relevantAlarms = currentAlarms.filter(a => a.name === baseName || (a.name.startsWith(baseName) && a.name.includes('#')));
        const usedIndices = new Set();
        const claimedNames = new Set();
        relevantAlarms.forEach(alarm => {
            const matchIdx = items.findIndex((item, idx) => !usedIndices.has(idx) && Math.abs(alarm.scheduledTime - item.scheduledTime) < 20000);
            if (matchIdx !== -1) {
                usedIndices.add(matchIdx);
                claimedNames.add(alarm.name);
                found.push({ name: alarm.name, delay: items[matchIdx].delay });
            }
        });
        const unmatchedItems = items.map((item, idx) => ({ item, idx })).filter(x => !usedIndices.has(x.idx)).sort((a, b) => a.item.delay - b.item.delay);
        unmatchedItems.forEach(entry => {
            const item = entry.item;
            let suffix = 1;
            let finalName = baseName;
            while (claimedNames.has(finalName) || found.some(f => f.name === finalName)) {
                suffix++;
                finalName = `${baseName} #${suffix}`;
            }
            claimedNames.add(finalName);
            found.push({ name: finalName, delay: item.delay });
        });
    }
    return found;
}

function parseTimeInput(val) {
    if (!val) return null;
    val = val.trim();
    if (val.includes(':')) {
        const parts = val.split(':').map(n => parseInt(n) || 0);
        if (parts.length === 3) return (parts[0]*3600 + parts[1]*60 + parts[2]) * 1000;
        if (parts.length === 2) return (parts[0]*60 + parts[1]) * 1000;
    }
    const num = parseFloat(val);
    if (!isNaN(num)) return num * 60 * 1000;
    return null;
}

function formatTimeLeft(ms) {
    const s = Math.max(0, (ms / 1000) | 0);
    const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, sc = s % 60;
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sc.toString().padStart(2, '0')}` : `${m}:${sc.toString().padStart(2, '0')}`;
}

async function syncState(force = false) {
    if (!force && document.querySelector('.inline-editor')) return;
    const res = await browser.runtime.sendMessage({ type: "GET_ACTIVE_ALARMS" });
    if (!res) return;
    let alarms = res.alarms || [];
    const now = Date.now();
    currentAlarms = alarms;
    localTracked = new Set(currentAlarms.map(a => a.name.replace(/\s#\d+$/, '')));
    if (typeof muteBtn !== 'undefined' && muteBtn) muteBtn.innerText = res.isMuted ? "🔇" : "🔊";
    currentAlarms.sort((a, b) => {
        const aD = (a.scheduledTime - now) <= 0;
        const bD = (b.scheduledTime - now) <= 0;
        if (aD !== bD) return aD ? -1 : 1; 
        if (aD && bD) {
            const getTag = (s) => {
                const m = s.match(/\[([^\]]+)\]\s*$/);
                return m ? m[1] : "zzz";
            };
            const tagA = getTag(a.name);
            const tagB = getTag(b.name);
            if (tagA !== tagB) return tagA.localeCompare(tagB);
        }
        if (a.scheduledTime !== b.scheduledTime) return a.scheduledTime - b.scheduledTime;
        return a.name.localeCompare(b.name);
    });
    rebuildUI(); 
}

function rebuildUI() {
    const existingNodes = new Map();
    listContainer.querySelectorAll('.alarm-item').forEach(el => {
        existingNodes.set(el.dataset.uid, el);
    });
    currentAlarms.forEach((a, index) => {
        const uid = a.id || a.name;
        let node = existingNodes.get(uid);
        if (node && node.querySelector('.inline-editor')) {
            node.remove();
            node = null;
        }
        if (!node) {
            node = createAlarmNode(a, uid);
        } 
        const currentNodeAtIndex = listContainer.children[index];
        if (currentNodeAtIndex !== node) {
            if (currentNodeAtIndex) {
                listContainer.insertBefore(node, currentNodeAtIndex);
            } else {
                listContainer.appendChild(node);
            }
        }
        uiRefs.set(uid, { 
            timeNode: node.querySelector('.t'), 
            nameNode: node.querySelector('.n'), 
            lastText: "" 
        });
        existingNodes.delete(uid);
    });
    existingNodes.forEach(node => node.remove());
    if (currentAlarms.length === 0) {
        if (!document.getElementById('empty-msg')) {
            listContainer.innerHTML = '<div id="empty-msg" style="color:#777; font-style:italic; text-align:center; padding: 15px;">No active timers</div>';
        }
    } else {
        const emptyMsg = document.getElementById('empty-msg');
        if (emptyMsg) emptyMsg.remove();
    }
}

function createAlarmNode(a, uniqueId) {
    const isCustom = a.name.startsWith('⭐');
    let extraClass = "";
    if (isCustom) { extraClass = (a.customType === 'manual') ? "baby-pink" : "lean-purple"; } 
    else if (a.name.includes('⚔️')) { extraClass = "hero-gold"; } 
    else if (a.name.includes('⚠️')) { extraClass = "res-alert"; }
    let displayName = a.name;
    if (a.name.includes('|')) {
        const idx = a.name.indexOf('|');
        const boldPart = a.name.substring(0, idx);
        const greyPart = a.name.substring(idx + 1);
        displayName = `${boldPart.trim()}<span style="color: #9ca3af !important; font-weight: normal; margin-left: 5px;">${greyPart.trim()}</span>`;
    } else {
        const parts = a.name.match(/^(.*?)(\s\(.*?\)\s\[.*?\])(\s#\d+)?$/);
        if (parts) { displayName = `${parts[1]}<span style="color: #9ca3af !important; font-weight: normal;">${parts[2]}</span>${parts[3] || ""}`; } 
        else {
            const oldParts = a.name.match(/^(.*?)(\s\(.*?\))(\s#\d+)?$/);
            if (oldParts) { displayName = `${oldParts[1]}<span style="color: #9ca3af !important; font-weight: normal;">${oldParts[2]}</span>${oldParts[3] || ""}`; }
        }
    }
    displayName = displayName.replace('⚠️', '<span class="danger-icon">⚠️</span>');
    if (a.recurring > 0) { displayName += `<span class="recurring-indicator" title="Recurring Alarm">↺</span>`; }
    const editBtn = isCustom ? `<span class="watchman-edit" title="Edit" data-uid="${uniqueId}">✎</span>` : '';
    const div = document.createElement('div');
    div.className = 'alarm-item';
    div.dataset.uid = uniqueId;
    div.innerHTML = `
        <div class="row-wrapper">
            <div class="trigger">
                <div class="name-container"><div class="n ${extraClass}" style="color:#fff; font-weight:bold; font-size:11px;">${displayName}</div></div>
                <div class="t">--:--</div>
            </div>
            ${editBtn}
            <span class="watchman-del" title="Delete" data-uid="${uniqueId}">🗑️</span>
        </div>`;
    setupAlarmListeners(div, a, uniqueId);
    return div;
}

function setupAlarmListeners(node, a, uniqueId) {
    const editBtn = node.querySelector('.watchman-edit');
    if (editBtn) {
        editBtn.onclick = (e) => {
            e.stopPropagation();
            const nameContainer = node.querySelector('.name-container');
            const timeNode = node.querySelector('.t');
            const rawName = a.name.replace(/^⭐\s*/, ''); 
            const timeLeftVal = formatTimeLeft(a.scheduledTime - Date.now());
            nameContainer.innerHTML = `<input type="text" class="inline-editor name-edit" value="">`;
            timeNode.innerHTML = `<input type="text" class="inline-editor time-edit" value="" style="width:40px; text-align:right;">`;
            const nameInput = nameContainer.querySelector('input');
            const timeInput = timeNode.querySelector('input');
            nameInput.value = rawName;
            timeInput.value = timeLeftVal;
            nameInput.focus();
            let saved = false;
            const save = () => {
                if (saved) return;
                setTimeout(() => {
                    if (document.activeElement === nameInput || document.activeElement === timeInput) return;
                    saved = true;
                    const newNameVal = nameInput.value.trim();
                    const newTimeStr = timeInput.value.trim();
                    const finalName = "⭐ " + (newNameVal || rawName);
                    const newDelay = parseTimeInput(newTimeStr);
                    if (newNameVal !== rawName || (newDelay && newTimeStr !== timeLeftVal)) {
                        browser.runtime.sendMessage({ type: "EDIT_ALARM", id: a.id, newName: finalName, newDelay: newDelay }).then(() => syncState(true));
                    } else { syncState(true); }
                }, 100);
            };
            const handleKey = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); } };
            nameInput.onclick = (ev) => ev.stopPropagation();
            nameInput.onkeydown = handleKey;
            nameInput.onblur = save;
            timeInput.onclick = (ev) => ev.stopPropagation();
            timeInput.onkeydown = handleKey;
            timeInput.onblur = save;
        };
    }
    node.querySelector('.trigger').onclick = () => {
        if (node.querySelector('.inline-editor')) return;
        const now = Date.now();
        const isDone = (a.scheduledTime - now) <= 0;
        const isRecurring = a.recurring && a.recurring > 0;
        if (isDone || isRecurring) {
            if (!silencedAlarms.has(uniqueId)) { 
                if (isDone) browser.runtime.sendMessage({ type: "STOP_SOUND_ONLY" }); 
                silencedAlarms.add(uniqueId); 
                syncState(); 
                if (!isDone) {
                    setTimeout(() => { if (silencedAlarms.has(uniqueId)) { silencedAlarms.delete(uniqueId); syncState(); } }, 5000);
                }
            } else {
                if (isRecurring) {
                    browser.runtime.sendMessage({ type: "REFRESH_ALARMS", buildings: [{ name: a.name, delay: a.recurring, recurring: a.recurring, customType: a.customType }] });
                }
                browser.runtime.sendMessage({ type: "DELETE_ALARM", id: a.id, name: a.name }).then(syncState);
            }
        }
    };
    node.querySelector('.watchman-del').onclick = (e) => { 
        e.stopPropagation(); 
        browser.runtime.sendMessage({ type: "DELETE_ALARM", id: a.id, name: a.name }).then(syncState); 
    };
}

function tick() {
    const now = Date.now();
    currentAlarms.forEach(a => {
        const uniqueId = a.id || a.name;
        const ref = uiRefs.get(uniqueId);
        if (!ref) return;
        const node = listContainer.querySelector(`[data-uid="${uniqueId}"]`);
        if (node && node.querySelector('.inline-editor')) return;
        const s = Math.max(0, ((a.scheduledTime - now) / 1000) | 0);
        let newText = "";
        const isSilenced = silencedAlarms.has(uniqueId);
        if (s === 0) {
            newText = "DONE"; 
            if (ref.lastText !== newText) { ref.timeNode.innerText = newText; }
            if (isSilenced) { 
                if (ref.timeNode.style.color !== "rgb(136, 136, 136)") {
                    ref.timeNode.style.color = "#888"; 
                    ref.timeNode.classList.remove('flashing-alarm'); 
                    ref.nameNode.classList.remove('flashing-alarm'); 
                }
            } else { 
                ref.nameNode.classList.remove('hero-gold', 'baby-pink', 'lean-purple', 'res-alert');
                if (ref.timeNode.style.color !== "rgb(255, 68, 68)") {
                    ref.timeNode.style.color = "#ff4444"; 
                    ref.timeNode.classList.add('flashing-alarm'); 
                    ref.nameNode.classList.add('flashing-alarm'); 
                }
            }
        } else {
            const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, sc = s % 60;
            newText = h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sc.toString().padStart(2, '0')}` : `${m}:${sc.toString().padStart(2, '0')}`;
            if (ref.lastText !== newText) { ref.timeNode.innerText = newText; }
            if (isSilenced) { if (ref.timeNode.style.color !== "rgb(136, 136, 136)") ref.timeNode.style.color = "#888"; } 
            else { if (ref.timeNode.style.color !== "rgb(113, 208, 0)") ref.timeNode.style.color = "#71d000"; }
        }
        ref.lastText = newText;
    });
}

const submitCustomAlarm = () => {
    const hrs = parseInt(hrInp.value, 10) || 0;
    const mins = parseInt(minInp.value, 10) || 0;
    const secs = parseInt(secInp.value, 10) || 0;
    const totalMs = (hrs * 3600 * 1000) + (mins * 60 * 1000) + (secs * 1000);
    if (!isNaN(totalMs) && totalMs > 0) {
        browser.runtime.sendMessage({ type: "REFRESH_ALARMS", buildings: [{ name: `⭐ ${nameInp.value.trim() || "Alarm"} ${serverTag}`, delay: totalMs, customType: 'manual' }] }).then(() => {
            nameInp.value = ""; hrInp.value = ""; minInp.value = ""; secInp.value = "";
            inputRow.style.display = 'none'; toggleBtn.innerText = '+'; syncState();
        });
    } else { inputRow.style.display = 'none'; toggleBtn.innerText = '+'; }
};

function loadShortcuts() {
    browser.storage.local.get({ watchmanShortcuts: [], watchmanHasInitialized: false }).then(async res => {
        let list = res.watchmanShortcuts;
        if (!res.watchmanHasInitialized || (list && list.length === 0 && !res.watchmanHasInitialized)) {
            await browser.storage.local.set({ watchmanShortcuts: DEFAULT_SHORTCUTS, watchmanHasInitialized: true });
            list = DEFAULT_SHORTCUTS;
        }
        const anchor = document.getElementById('dynamic-options-anchor');
        if (!anchor) return;
        anchor.innerHTML = ''; 
        list.forEach(s => {
            const opt = document.createElement('div');
            opt.className = 'dropdown-option clickable';
            const activeClass = s.isRecurring ? 'is-active' : '';
            opt.innerHTML = `<span>${s.label}</span><div class="shortcut-actions"><span class="recurring-toggle ${activeClass}" title="Toggle Recurring">↺</span><span class="edit-shortcut" title="Edit Shortcut">✎</span><span class="remove-shortcut" title="Delete Shortcut">✕</span></div>`;
            opt.onclick = (e) => { e.stopPropagation(); handleDropdownAction(s.minutes, s.label, s.isRecurring); document.getElementById('custom-dropdown-menu').style.display = 'none'; };
            const recBtn = opt.querySelector('.recurring-toggle');
            recBtn.onclick = (e) => { e.stopPropagation(); toggleRecurringShortcut(s.label); };
            const editBtn = opt.querySelector('.edit-shortcut');
            editBtn.onclick = (e) => { e.stopPropagation(); editShortcut(s.label, s.minutes); };
            opt.querySelector('.remove-shortcut').onclick = (e) => { e.stopPropagation(); deleteShortcut(s.label); };
            anchor.appendChild(opt);
        });
    });
}

async function editShortcut(oldLabel, oldMinutes) {
    const newMinutesStr = prompt("Edit duration (minutes):", oldMinutes);
    if (!newMinutesStr || isNaN(newMinutesStr)) return;
    const newLabel = prompt("Edit label:", oldLabel);
    if (!newLabel) return;
    const res = await browser.storage.local.get({ watchmanShortcuts: [] });
    const newList = res.watchmanShortcuts.map(s => { if (s.label === oldLabel) { return { ...s, label: newLabel, minutes: parseInt(newMinutesStr) }; } return s; });
    await browser.storage.local.set({ watchmanShortcuts: newList });
    loadShortcuts();
}

async function toggleRecurringShortcut(label) {
    const res = await browser.storage.local.get({ watchmanShortcuts: [] });
    const newList = res.watchmanShortcuts.map(s => { if (s.label === label) { return { ...s, isRecurring: !s.isRecurring }; } return s; });
    await browser.storage.local.set({ watchmanShortcuts: newList });
    loadShortcuts();
}

async function handleDropdownAction(val, label, isRecurring) {
    if (val === "CREATE_NEW") {
        const mins = prompt("Enter duration in minutes:");
        if (mins && !isNaN(mins)) {
            const labelStr = prompt("Enter label (e.g. 45m):", mins + "m");
            if (labelStr) {
                const res = await browser.storage.local.get({ watchmanShortcuts: DEFAULT_SHORTCUTS });
                const newList = [...res.watchmanShortcuts, { label: labelStr, minutes: parseInt(mins), isRecurring: false }];
                await browser.storage.local.set({ watchmanShortcuts: newList, watchmanHasInitialized: true });
                loadShortcuts();
            }
        }
        return;
    }
    const mins = parseInt(val);
    const msDelay = mins * 60 * 1000;
    browser.runtime.sendMessage({ type: "REFRESH_ALARMS", buildings: [{ name: `⭐ ${label || mins + 'm Timer'} ${serverTag}`, delay: msDelay, recurring: isRecurring ? msDelay : 0 }] }).then(() => syncState());
}

async function deleteShortcut(label) {
    const res = await browser.storage.local.get({ watchmanShortcuts: [] });
    const newList = res.watchmanShortcuts.filter(s => s.label !== label);
    await browser.storage.local.set({ watchmanShortcuts: newList, watchmanHasInitialized: true });
    loadShortcuts();
}

function startLoops() {
    setInterval(syncState, 200); 
    const loop = () => { tick(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    new MutationObserver(() => scan()).observe(document.body, { childList: true, subtree: true });
    scan();
}

function createWidget() {
    const div = document.createElement('div');
    div.id = 'travian-timer-widget';
    div.innerHTML = WIDGET_HTML;
    document.body.appendChild(div);
    const dropdownBtn = div.querySelector('#dropdown-trigger-btn');
    const dropdownMenu = div.querySelector('#custom-dropdown-menu');
    const minBtn = div.querySelector('#minimize-btn');
    const inputRow = div.querySelector('#input-row');
    const toggleBtn = div.querySelector('#toggle-input');
    const nameInp = div.querySelector('#cust-name');
    const hrInp = div.querySelector('#cust-hr');
    const minInp = div.querySelector('#cust-min');
    const secInp = div.querySelector('#cust-sec');
    minBtn.onclick = () => { div.classList.toggle('is-minimized'); minBtn.innerText = div.classList.contains('is-minimized') ? '▢' : '—'; };
    dropdownBtn.onclick = (e) => { e.stopPropagation(); dropdownMenu.style.display = dropdownMenu.style.display === 'block' ? 'none' : 'block'; };
    document.addEventListener('click', () => { if(dropdownMenu) dropdownMenu.style.display = 'none'; });
    div.querySelector('#create-new-trigger').onclick = () => handleDropdownAction("CREATE_NEW", "");
    toggleBtn.onclick = () => { if (inputRow.style.display === 'flex') { submitCustomAlarm(); } else { inputRow.style.display = 'flex'; toggleBtn.innerText = '✓'; nameInp.focus(); } };
    [nameInp, hrInp, minInp, secInp].forEach(input => { input.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitCustomAlarm(); }); });
    const clearBtn = div.querySelector('#clear-all');
    clearBtn.onclick = async () => { if (currentAlarms.length === 0) return; if (confirm("Clear all active timers?")) { const deletePromises = currentAlarms.map(a => browser.runtime.sendMessage({ type: "DELETE_ALARM", name: a.name })); await Promise.all(deletePromises); silencedAlarms.clear(); syncState(); } };
    const muteBtn = div.querySelector('#mute-toggle');
    muteBtn.onclick = () => { browser.runtime.sendMessage({ type: "TOGGLE_MUTE" }).then(res => { if (res) muteBtn.innerText = res.isMuted ? "🔇" : "🔊"; }); };
    return { timerWidget: div, listContainer: div.querySelector('#timer-list'), inputRow, toggleBtn, nameInp, hrInp, minInp, secInp, muteBtn };
}

const WIDGET_HTML = `
    <div style="padding: 10px; border-bottom: 1px solid #444; background: rgba(20, 20, 20, 0.95); border-radius: 8px 8px 0 0;">
        <div class="header-controls">
            <button id="minimize-btn" class="add-btn" title="Minimize">—</button>
            <button id="clear-all" class="add-btn" title="Clear All">🗑️</button>
            <div id="custom-dropdown-container">
                <div id="dropdown-trigger-btn" title="Quick Timers"></div>
                <div id="custom-dropdown-menu">
                    <div class="dropdown-option dropdown-header">PRESETS</div>
                    <div id="dynamic-options-anchor"></div>
                    <div class="dropdown-option clickable new-btn" id="create-new-trigger">+ New</div>
                </div>
            </div>
            <button id="toggle-input" class="add-btn">+</button>
            <span id="mute-toggle" style="cursor: pointer; font-size: 14px;">🔊</span>
        </div>
        <div id="input-row">
            <input type="text" id="cust-name" class="custom-input" placeholder="Name" style="width: 60px;">
            <input type="number" id="cust-hr" class="custom-input" placeholder="H" style="width: 24px;">
            <input type="number" id="cust-min" class="custom-input" placeholder="M" style="width: 24px;">
            <input type="number" id="cust-sec" class="custom-input" placeholder="S" style="width: 24px;">
        </div>
    </div>
    <div id="timer-list" style="padding: 5px 10px; font-size: 10px; color: #ccc; max-height: 380px; overflow-y: scroll; background: rgba(30, 30, 30, 0.9); border-radius: 0 0 8px 8px;"></div>
`;

const { timerWidget, listContainer, inputRow, toggleBtn, nameInp, hrInp, minInp, secInp, muteBtn } = createWidget();
loadShortcuts();
startLoops();