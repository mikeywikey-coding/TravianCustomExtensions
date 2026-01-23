/**
 * TRAVIAN WATCHMAN PRO - CONTENT SCRIPT
 * Version: 3.37 (Fixed & Complete)
 */

// ==========================================
// CONFIGURATION & STATE
// ==========================================
let lastNamesKey = "";
let silencedAlarms = new Set();
let localTracked = new Set();
let currentAlarms = [];
let suppressedAttacks = new Set(); 
const uiRefs = new Map();

// Throttle Flag
let isScanning = false;

// Debounce counter for clearing attacks
let noAttackConsecutiveScans = 0; 

// ==========================================
// SERVER TAG GENERATION
// ==========================================
const generateServerTag = () => {
    let host = window.location.hostname;
    host = host.replace(/^www\./, '').replace(/\.travian\.[a-z]+$/, '');

    const regionShorteners = {
        'europe': 'eur', 'america': 'ame', 'arabia': 'ara',
        'international': 'int', 'hispano': 'esp', 'nordic': 'nor',
        'balkans': 'blk', 'asia': 'asi', 'com': '' 
    };

    const parts = host.split('.').map(part => {
        return regionShorteners[part] || part;
    }).filter(p => p !== ''); 

    return `[${parts.join('.')}]`;
};

const serverTag = generateServerTag();

const DEFAULT_SHORTCUTS = [
    { label: "15m", minutes: 15, isRecurring: false },
    { label: "30m", minutes: 30, isRecurring: false }
];

const cleanText = (str) => str.replace(/\s+/g, ' ').trim();
const cleanCoords = (str) => str.replace(/[^\d|−-]/g, '').replace('−', '-');

// ==========================================
// HELPERS
// ==========================================

function parseSmartDuration(input) {
    if (!input) return null;
    let str = input.toString().trim();
    
    if (str.includes(':') || str.includes('.')) {
        let parts = str.replace('.', ':').split(':').map(n => parseInt(n, 10) || 0);
        if (parts.length === 3) return (parts[0] * 3600 * 1000) + (parts[1] * 60 * 1000) + (parts[2] * 1000);
        if (parts.length === 2) return (parts[0] * 60 * 1000) + (parts[1] * 1000);
    }
    
    const num = parseFloat(str);
    if (!isNaN(num)) return num * 60 * 1000;
    return null;
}

function formatDurationForPrompt(ms) {
    if (ms < 0) return "0";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    if (s === 0) return `${m}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function generateSmartBuildingName() {
    const possibleHeaders = [
        document.querySelector('.windowTitle'),
        document.querySelector('#content .titleInHeader'),
        document.querySelector('div.fluidHeading'),
        document.querySelector('h1')
    ];
    const headerNode = possibleHeaders.find(el => el && el.innerText.trim().length > 0);
    let rawName = headerNode ? headerNode.innerText.trim() : "";
    if (!rawName) return "Reinforcements in";

    const match = rawName.match(/^(.*?)\s(?:Level|Lvl|level)\s*(\d+)$/i);
    if (match) {
        const namePart = match[1].trim();
        const currentLevel = parseInt(match[2], 10);
        return `Queue ${namePart} Level ${currentLevel + 1}`;
    }
    return `Queue ${rawName}`;
}

function calculateDelayFromSmartText(text, node = null) {
    if (node && node.getAttribute('value')) {
        const seconds = parseInt(node.getAttribute('value'), 10);
        if (!isNaN(seconds)) return seconds * 1000;
    }

    if (!text) return null;

    let clean = text.toLowerCase()
                    .replace(/in/g, '')
                    .replace(/hrs\.?/g, '')
                    .replace(/min\.?/g, '')
                    .replace(/sec\.?/g, '')
                    .replace(/,/g, '') 
                    .trim();

    const hmsMatch = clean.match(/^(\d{1,2})[:.](\d{1,2})[:.](\d{1,2})$/);
    if (hmsMatch) {
        const h = parseInt(hmsMatch[1], 10);
        const m = parseInt(hmsMatch[2], 10);
        const s = parseInt(hmsMatch[3], 10);
        return (h * 3600 * 1000) + (m * 60 * 1000) + (s * 1000);
    }

    const timeMatch = clean.match(/(\d{1,2}):(\d{2})/);
    const dateMatch = clean.match(/(\d{1,2})\.(\d{2})/);
    
    if (timeMatch) {
        const now = new Date();
        let targetDate = new Date();

        if (dateMatch) {
            const day = parseInt(dateMatch[1], 10);
            const month = parseInt(dateMatch[2], 10) - 1; 
            targetDate.setFullYear(now.getFullYear(), month, day);
        }

        targetDate.setHours(parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0, 0);

        if (!dateMatch && targetDate.getTime() <= now.getTime()) {
            targetDate.setDate(targetDate.getDate() + 1);
        } 
        else if (dateMatch && targetDate.getTime() < (now.getTime() - 86400000)) {
            targetDate.setFullYear(now.getFullYear() + 1);
        }

        return targetDate.getTime() - now.getTime();
    }

    return parseSmartDuration(clean);
}

function getStyledDisplayName(rawName, isRecurring) {
    let cleanName = rawName.replace(/\[[^\]]+\]/g, '').trim();
    cleanName = cleanName.replace(/\s{2,}/g, ' ');

    let displayName = cleanName;

    if (cleanName.includes('|')) {
        const idx = cleanName.indexOf('|');
        const boldPart = cleanName.substring(0, idx);
        const greyPart = cleanName.substring(idx + 1);
        displayName = `${boldPart.trim()}<span style="color: #9ca3af !important; font-weight: normal; margin-left: 5px;">${greyPart.trim()}</span>`;
    } else {
        const parts = cleanName.match(/^(.*?)(\s\(.*?\))(\s#\d+)?$/);
        if (parts) {
            displayName = `${parts[1]}<span style="color: #9ca3af !important; font-weight: normal;">${parts[2]}${parts[3] || ""}</span>`;
        }
    }

    displayName = displayName.replace(serverTag, '').trim(); 
    displayName = displayName.replace('⚠️', '<span class="danger-icon">⚠️</span>');
    if (isRecurring) displayName += `<span class="recurring-indicator" title="Recurring Alarm">↺</span>`; 
    
    return displayName;
}

// ==========================================
// CORE LOGIC: SCANNERS
// ==========================================

function scan() {
    if (isScanning) return;
    isScanning = true;
    setTimeout(() => { isScanning = false; }, 50);

    if (typeof timerWidget !== 'undefined' && timerWidget) {
        const isMap = window.location.pathname.includes('karte.php');
        const isFull = new URLSearchParams(window.location.search).get('fullscreen') === '1';
        timerWidget.style.display = (isMap && isFull) ? 'none' : '';
    }

    try {
        const villageMap = scanVillages(); 
        const activeVillage = getActiveVillageName();
        const found = [];
        let matchedBuildingIds = null; 

        try {
            const scanResult = scanBuildings(activeVillage);
            if (scanResult !== null) {
                found.push(...scanResult.newBuildings);
                matchedBuildingIds = scanResult.matchedIds;
            }
        } catch (e) { console.error("Building Scan Error:", e); }

        try {
            const heroStatuses = scanHero(activeVillage, villageMap);
            if (heroStatuses && heroStatuses.length > 0) found.push(...heroStatuses); 
        } catch (e) { console.error("Hero Scan Error:", e); }

        try {
            const attacks = scanAttacks(activeVillage);
            if (attacks.length > 0) found.push(...attacks);
        } catch (e) { console.error("Attack Scan Error:", e); }

        try {
            const sidebarAttacks = scanSidebarAttacks();
            if (sidebarAttacks.length > 0) found.push(...sidebarAttacks);
        } catch (e) { console.error("Sidebar Scan Error:", e); }

        if (matchedBuildingIds !== null) handleQueueCleanup(matchedBuildingIds, activeVillage);
        if (found.length > 0) browser.runtime.sendMessage({ type: "REFRESH_ALARMS", buildings: found });
        
    } catch (err) { console.error("Watchman Main Loop Error:", err); }
}

function scanSidebarAttacks() {
    const listEntries = document.querySelectorAll('.villageList .listEntry');
    if (!listEntries || listEntries.length === 0) return [];

    const attackedVillages = [];
    listEntries.forEach(entry => {
        if (entry.classList.contains('attack')) {
            const nameNode = entry.querySelector('.name');
            if (nameNode) attackedVillages.push(cleanText(nameNode.innerText));
        }
    });

    if (attackedVillages.length > 0) {
        noAttackConsecutiveScans = 0;
        const namesStr = attackedVillages.join(', ');
        const alarmName = `⚠️ ATTACK: ${namesStr} ${serverTag}`;

        currentAlarms.forEach(a => {
            if (a.name.startsWith('⚠️ ATTACK:') && a.name !== alarmName && a.name.includes(serverTag)) {
                browser.runtime.sendMessage({ type: "DELETE_ALARM", id: a.id, name: a.name });
            }
        });

        if (suppressedAttacks.has(alarmName)) return []; 
        const exists = currentAlarms.some(a => a.name === alarmName);
        if (!exists) return [{ name: alarmName, delay: 1000, customType: 'attack' }];
    } else {
        noAttackConsecutiveScans++;
        if (noAttackConsecutiveScans === 20) {
            currentAlarms.forEach(a => {
                if ((a.name.startsWith('⚠️ ATTACK:') || a.name.startsWith('⚠️ INCOMING ATTACKS!')) && a.name.includes(serverTag)) {
                    browser.runtime.sendMessage({ type: "ATTACK_CLEARED", name: a.name });
                    browser.runtime.sendMessage({ type: "DELETE_ALARM", id: a.id, name: a.name });
                }
            });
        }
    }
    return [];
}

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
            bName: bName, bLevel: bLevel,
            baseName: `${bName} lvl ${bLevel} (${activeVillage}) ${serverTag}`,
            delay: delayValue, scheduledTime: now + delayValue
        });
    });

    rawBuildings.sort((a, b) => a.scheduledTime - b.scheduledTime);

    const nameCounts = {};
    const processedBuildings = rawBuildings.map(b => {
        if (!nameCounts[b.baseName]) nameCounts[b.baseName] = 0;
        nameCounts[b.baseName]++;
        let finalName = b.baseName;
        if (nameCounts[b.baseName] > 1) finalName = `${b.baseName} #${nameCounts[b.baseName]}`;
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
        if ((a.scheduledTime - now) > 10000) {
            browser.runtime.sendMessage({ type: "DELETE_ALARM", id: a.id, name: a.name });
        }
    });
}

function scanHero(activeVillage, villageMap) {
    const heroTimers = document.querySelectorAll('.heroStatus .timer, #sidebarBoxHero .timer, .tippy-content .timer, #travian_tooltip .timer');
    if (!heroTimers || heroTimers.length === 0) return [];

    const foundHeroes = [];

    heroTimers.forEach(heroTimer => {
        const parent = heroTimer.closest('.heroStatus, #sidebarBoxHero, .tippy-content, #travian_tooltip');
        if (!parent) return;

        const rawStatus = parent.querySelector('.text')?.innerText || "";
        const rawStatusLower = rawStatus.toLowerCase();
        
        const delayValue = ((heroTimer.getAttribute('value') | 0) * 1000) + 2000;
        const scheduledTime = Date.now() + delayValue;
        
        if (delayValue <= 0) return;

        const coordMatch = rawStatus.match(/\([−-]?\d+[|/][−-]?\d+\)/);
        let matchedVillageName = "";
        if (coordMatch) {
            const key = cleanCoords(coordMatch[0]);
            matchedVillageName = villageMap[key];
        }

        const homeLink = parent.querySelector('a[href*="id="]');
        let originName = homeLink ? cleanText(homeLink.innerText.split('\n')[0]) : (activeVillage || "Home Village");

        let actionLabel = "";
        let targetName = "";

        if (rawStatusLower.includes("oasis")) { actionLabel = "Going to Oasis"; targetName = originName; }
        else if (rawStatusLower.includes("adventure")) { actionLabel = "Going to Adventure"; targetName = originName; }
        else if (rawStatusLower.includes("reinforce")) { actionLabel = "Reinforcing"; targetName = matchedVillageName || (coordMatch ? coordMatch[0] : originName); }
        else { actionLabel = "Returning to"; targetName = matchedVillageName || (coordMatch ? coordMatch[0] : originName); }

        // --- WRAPPED ICON FOR CSS POSITIONING ---
        const heroName = `<span class="hero-icon">⚔️</span> ${cleanText(`${actionLabel} | ${targetName}`)} ${serverTag}`;
        
        const serverHeroExists = currentAlarms.some(a => a.name.includes(actionLabel) && a.name.includes(serverTag) && Math.abs(a.scheduledTime - scheduledTime) < 30000);

        if (!serverHeroExists && !localTracked.has(heroName)) {
            localTracked.add(heroName);
            foundHeroes.push({ name: heroName, delay: delayValue });
        }
    });
    return foundHeroes;
}

function scanAttacks(activeVillage) {
    const p = new URLSearchParams(window.location.search);
    if (p.get('gid') !== '16' || p.get('tt') !== '1' || p.get('filter') !== '1' || p.get('subfilters') !== '1') return [];
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
                attacksOnScreen.push({ baseName: baseName, delay: delayValue, scheduledTime: now + delayValue });
            }
        }
    });
    
    const groups = {};
    attacksOnScreen.forEach(a => { if (!groups[a.baseName]) groups[a.baseName] = []; groups[a.baseName].push(a); });
    
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

// ==========================================
// SYNC STATE & UI REFRESH
// ==========================================
async function syncState(force = false) {
    if (!force && document.querySelector('.inline-editor')) return;
    
    // 1. Get Alarms & Sound Mode
    const res = await browser.runtime.sendMessage({ type: "GET_ACTIVE_ALARMS" });
    if (!res) return;

    let alarms = res.alarms || [];
    const now = Date.now();
    currentAlarms = alarms;
    localTracked = new Set(currentAlarms.map(a => a.name.replace(/\s#\d+$/, '')));

    // 2. FAIL-SAFE ICON UPDATE
    const btn = document.getElementById('audio-trigger-btn');
    if (btn) {
        const mode = res.soundMode || 'all';
        if (mode === 'all') { btn.innerText = "🔊"; btn.style.opacity = "1"; }
        else if (mode === 'attacks') { btn.innerText = "⚔️"; btn.style.opacity = "1"; }
        else { btn.innerText = "🔇"; btn.style.opacity = "1"; }

        const opts = document.querySelectorAll('.audio-option');
        if (opts) {
            opts.forEach(opt => {
                if (opt.dataset.mode === mode) opt.classList.add('is-active-mode');
                else opt.classList.remove('is-active-mode');
            });
        }
    }

    // 3. Sort & Rebuild List (PRIORITIZES PINNED ITEMS)
    currentAlarms.sort((a, b) => {
        if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1; // Pinned first

        const aDone = (a.scheduledTime - now) <= 0;
        const bDone = (b.scheduledTime - now) <= 0;
        if (aDone !== bDone) return aDone ? -1 : 1; 
        
        if (aDone && bDone) {
            const getTag = (s) => { const m = s.match(/\[([^\]]+)\]\s*$/); return m ? m[1] : "zzz"; };
            const tagA = getTag(a.name);
            const tagB = getTag(b.name);
            if (tagA !== tagB) return tagA.localeCompare(tagB);

            const getVillage = (s) => { 
                let clean = s.replace(/\[[^\]]+\]/g, '').trim(); 
                const pMatch = clean.match(/\(([^)]+)\)/);
                if (pMatch) return pMatch[1].trim(); 
                if (clean.includes('|')) return clean.split('|')[1].trim(); 
                return "ZZ_Global"; 
            };
            const villA = getVillage(a.name);
            const villB = getVillage(b.name);
            if (villA !== villB) return villA.localeCompare(villB);
            return a.name.localeCompare(b.name);
        }
        if (a.scheduledTime !== b.scheduledTime) return a.scheduledTime - b.scheduledTime;
        return a.name.localeCompare(b.name);
    });
    rebuildUI(); 
}

function rebuildUI() {
    const existingNodes = new Map();
    listContainer.querySelectorAll('.alarm-item').forEach(el => existingNodes.set(el.dataset.uid, el));
    
    currentAlarms.forEach((a, index) => {
        const uid = a.id || a.name;
        let node = existingNodes.get(uid);
        if (node && node.querySelector('.inline-editor')) { node.remove(); node = null; }
        
        if (!node) node = createAlarmNode(a, uid);
        else {
            const nameNode = node.querySelector('.n');
            if (nameNode) nameNode.innerHTML = getStyledDisplayName(a.name, a.recurring > 0);
            
            const pinBtn = node.querySelector('.watchman-pin');
            if (pinBtn) {
                if (a.isPinned) pinBtn.classList.add('active-pin');
                else pinBtn.classList.remove('active-pin');
            }
            if (a.isPinned) node.classList.add('is-pinned-row');
            else node.classList.remove('is-pinned-row');
        }

        const currentNodeAtIndex = listContainer.children[index];
        if (currentNodeAtIndex !== node) {
            if (currentNodeAtIndex) listContainer.insertBefore(node, currentNodeAtIndex);
            else listContainer.appendChild(node);
        }
        uiRefs.set(uid, { timeNode: node.querySelector('.t'), nameNode: node.querySelector('.n'), lastText: "" });
        existingNodes.delete(uid);
    });
    existingNodes.forEach(node => node.remove());
    if (currentAlarms.length === 0) {
        if (!document.getElementById('empty-msg')) listContainer.innerHTML = '<div id="empty-msg" style="color:#777; font-style:italic; text-align:center; padding: 15px;">No active timers</div>';
    } else {
        const emptyMsg = document.getElementById('empty-msg');
        if (emptyMsg) emptyMsg.remove();
    }
}

function createAlarmNode(a, uniqueId) {
    const isCustom = a.name.startsWith('⭐');
    let extraClass = "";
    if (isCustom) extraClass = (a.customType === 'manual') ? "baby-pink" : "lean-purple";
    else if (a.name.includes('⚔️')) extraClass = "hero-gold";
    else if (a.name.includes('⚠️')) extraClass = "res-alert";
    
    const pinnedClass = a.isPinned ? "is-pinned-row" : "";
    const pinActive = a.isPinned ? "active-pin" : "";

    const displayName = getStyledDisplayName(a.name, a.recurring > 0);
    const editBtn = isCustom ? `<span class="watchman-edit" title="Edit" data-uid="${uniqueId}">✎</span>` : '';
    
    const div = document.createElement('div');
    div.className = `alarm-item ${pinnedClass}`;
    div.dataset.uid = uniqueId;
    div.innerHTML = `
        <div class="row-wrapper">
            <div class="pin-hover-zone"></div>
            <div class="right-hover-zone"></div>
            
            <span class="watchman-pin ${pinActive}" title="Pin to top" data-uid="${uniqueId}">📌</span>
            <div class="trigger">
                <div class="name-container"><div class="n ${extraClass}" style="color:#fff; font-weight:bold; font-size:11px;">${displayName}</div></div>
                <div class="t">--:--</div>
            </div>
            <div class="action-group">
                ${editBtn}
                <span class="watchman-del" title="Delete" data-uid="${uniqueId}">🗑️</span>
            </div>
        </div>`;
    setupAlarmListeners(div, a, uniqueId);
    return div;
}

function setupAlarmListeners(node, a, uniqueId) {
    // Pin Listener
    const pinBtn = node.querySelector('.watchman-pin');
    if (pinBtn) {
        pinBtn.onclick = (e) => {
            e.stopPropagation();
            pinBtn.classList.toggle('active-pin');
            node.classList.toggle('is-pinned-row');
            browser.runtime.sendMessage({ type: "TOGGLE_PIN", id: a.id }).then(() => syncState(true));
        };
    }

    const editBtn = node.querySelector('.watchman-edit');
    if (editBtn) {
        editBtn.onclick = (e) => {
            e.stopPropagation();
            let currentTag = serverTag;
            const tagMatch = a.name.match(/\[[^\]]+\]/);
            if (tagMatch) currentTag = tagMatch[0];

            let middleContent = a.name.replace(currentTag, '').replace(/^⭐\s*/, '').trim();
            let villageContext = "";
            let nameToEdit = middleContent;

            if (middleContent.includes('|')) {
                const parts = middleContent.split('|');
                nameToEdit = parts[0].trim();
                villageContext = parts[1].trim();
            } else {
                const pMatch = middleContent.match(/^(.*?)(\s\(.*?\))(\s#\d+)?$/);
                if (pMatch) {
                    nameToEdit = pMatch[1].trim();
                    villageContext = pMatch[2].replace(/[()]/g, '').trim(); 
                }
            }

            const newNameVal = prompt("Edit Name:", nameToEdit);
            if (newNameVal === null) return; 

            const currentDurationStr = formatDurationForPrompt(a.scheduledTime - Date.now());
            const newTimeStr = prompt("Edit Time Remaining (e.g. 15, 1:30):", currentDurationStr);
            if (newTimeStr === null) return; 

            let finalBaseName = newNameVal.trim() || nameToEdit;
            if (villageContext) finalBaseName = `${finalBaseName} | ${villageContext}`;

            const finalName = `⭐ ${finalBaseName} ${currentTag}`;
            const newDelay = parseSmartDuration(newTimeStr);
            
            if (newNameVal !== nameToEdit || (newDelay !== null)) {
                browser.runtime.sendMessage({ type: "EDIT_ALARM", id: a.id, newName: finalName, newDelay: newDelay }).then(() => syncState(true));
            }
        };
    }
    
    // Consolidated Click Logic
    const handleTriggerClick = () => {
        if (node.querySelector('.inline-editor')) return;
        const now = Date.now();
        const isDone = (a.scheduledTime - now) <= 0;
        const isRecurring = a.recurring && a.recurring > 0;
        if (isDone || isRecurring) {
            if (!silencedAlarms.has(uniqueId)) { 
                if (isDone) browser.runtime.sendMessage({ type: "STOP_SOUND_ONLY" }); 
                silencedAlarms.add(uniqueId); 
                syncState(); 
                if (!isDone) setTimeout(() => { if (silencedAlarms.has(uniqueId)) { silencedAlarms.delete(uniqueId); syncState(); } }, 5000);
            } else {
                if (isRecurring) browser.runtime.sendMessage({ type: "REFRESH_ALARMS", buildings: [{ name: a.name, delay: a.recurring, recurring: a.recurring, customType: a.customType }] });
                browser.runtime.sendMessage({ type: "DELETE_ALARM", id: a.id, name: a.name }).then(syncState);
            }
        }
    };

    const trigger = node.querySelector('.trigger');
    if (trigger) trigger.onclick = handleTriggerClick;
    
    const leftZone = node.querySelector('.pin-hover-zone');
    if (leftZone) leftZone.onclick = handleTriggerClick;
    
    // New Right Zone Click Handler
    const rightZone = node.querySelector('.right-hover-zone');
    if (rightZone) rightZone.onclick = handleTriggerClick;

    node.querySelector('.watchman-del').onclick = (e) => { 
        e.stopPropagation(); 
        if (a.customType === 'attack') suppressedAttacks.add(a.name);
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
            if (ref.lastText !== newText) ref.timeNode.innerText = newText;
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
            if (ref.lastText !== newText) ref.timeNode.innerText = newText;
            if (isSilenced) { if (ref.timeNode.style.color !== "rgb(136, 136, 136)") ref.timeNode.style.color = "#888"; } 
            else { if (ref.timeNode.style.color !== "rgb(113, 208, 0)") ref.timeNode.style.color = "#71d000"; }
        }
        ref.lastText = newText;
    });
}

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
            const durationMs = s.ms || (s.minutes * 60 * 1000);
            
            opt.innerHTML = `<span>${s.label}</span><div class="shortcut-actions"><span class="recurring-toggle ${activeClass}" title="Toggle Recurring">↺</span><span class="edit-shortcut" title="Edit Shortcut">✎</span><span class="remove-shortcut" title="Delete Shortcut">✕</span></div>`;
            opt.onclick = (e) => { e.stopPropagation(); handleDropdownAction(durationMs, s.label, s.isRecurring); document.getElementById('custom-dropdown-menu').style.display = 'none'; };
            const recBtn = opt.querySelector('.recurring-toggle');
            recBtn.onclick = (e) => { e.stopPropagation(); toggleRecurringShortcut(s.label); };
            const editBtn = opt.querySelector('.edit-shortcut');
            editBtn.onclick = (e) => { e.stopPropagation(); editShortcut(s.label, durationMs); };
            opt.querySelector('.remove-shortcut').onclick = (e) => { e.stopPropagation(); deleteShortcut(s.label); };
            anchor.appendChild(opt);
        });
    });
}

async function editShortcut(oldLabel, oldMs) {
    const currentDurationStr = formatDurationForPrompt(oldMs);
    const newDurationStr = prompt("Edit duration (e.g. 15, 13:30, 13.30):", currentDurationStr);
    const newMs = parseSmartDuration(newDurationStr);
    if (newMs === null) return;
    const newLabel = prompt("Edit label:", oldLabel);
    if (!newLabel) return;
    const res = await browser.storage.local.get({ watchmanShortcuts: [] });
    const newList = res.watchmanShortcuts.map(s => { if (s.label === oldLabel) return { ...s, label: newLabel, ms: newMs, minutes: undefined }; return s; });
    await browser.storage.local.set({ watchmanShortcuts: newList });
    loadShortcuts();
}

async function toggleRecurringShortcut(label) {
    const res = await browser.storage.local.get({ watchmanShortcuts: [] });
    const newList = res.watchmanShortcuts.map(s => { if (s.label === label) return { ...s, isRecurring: !s.isRecurring }; return s; });
    await browser.storage.local.set({ watchmanShortcuts: newList });
    loadShortcuts();
}

async function handleDropdownAction(val, label, isRecurring) {
    if (val === "CREATE_NEW") {
        const durStr = prompt("Enter duration (e.g. 15, 13:30, 13.30):");
        const ms = parseSmartDuration(durStr);
        if (ms !== null) {
            const defaultLabel = formatDurationForPrompt(ms) + "m";
            const labelStr = prompt("Enter label:", defaultLabel);
            if (labelStr) {
                const res = await browser.storage.local.get({ watchmanShortcuts: DEFAULT_SHORTCUTS });
                const newList = [...res.watchmanShortcuts, { label: labelStr, ms: ms, isRecurring: false }];
                await browser.storage.local.set({ watchmanShortcuts: newList, watchmanHasInitialized: true });
                loadShortcuts();
            }
        }
        return;
    }
    const vName = getActiveVillageName();
    browser.runtime.sendMessage({ type: "REFRESH_ALARMS", buildings: [{ name: `⭐ ${label} | ${vName} ${serverTag}`, delay: val, recurring: isRecurring ? val : 0 }] }).then(() => syncState());
}

async function deleteShortcut(label) {
    const res = await browser.storage.local.get({ watchmanShortcuts: [] });
    const newList = res.watchmanShortcuts.filter(s => s.label !== label);
    await browser.storage.local.set({ watchmanShortcuts: newList, watchmanHasInitialized: true });
    loadShortcuts();
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "OPEN_CONTEXT_ADD") {
        let prefilled = generateSmartBuildingName().replace(/,/g, '').replace(/\s+/g, ' ').trim();
        setTimeout(() => {
            const name = prompt("Enter Alarm Name:", prefilled);
            if (!name) return;
            let text = msg.selectionText;
            let sourceNode = null;
            if (!text) { sourceNode = document.querySelector('.window .timer, #content .timer, .buildDuration .timer'); if (sourceNode) text = sourceNode.innerText; }
            let d = calculateDelayFromSmartText(text, sourceNode);
            if (d === null) { const t = prompt("Could not auto-detect time. Enter duration (e.g. 15, 1:30):"); if (t) d = parseSmartDuration(t); }
            if (d !== null && d > 0) {
                browser.runtime.sendMessage({ type: "REFRESH_ALARMS", buildings: [{ name: `⭐ ${name} | ${getActiveVillageName()} ${serverTag}`, delay: d - 5000, customType: 'manual' }] }).then(() => syncState(true));
            }
        }, 50);
    }
});

function handleContextParser(text) {
    if (!text) return;
    const timeMatch = text.match(/(\d{1,2})[:.](\d{1,2})/);
    if (timeMatch) {
        const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\./);
        const now = new Date();
        let targetDate = new Date();
        if (dateMatch) targetDate.setFullYear(now.getFullYear(), parseInt(dateMatch[2], 10) - 1, parseInt(dateMatch[1], 10));
        const hrs = parseInt(timeMatch[1], 10);
        const mins = parseInt(timeMatch[2], 10);
        targetDate.setHours(hrs, mins, 0, 0);
        if (!dateMatch && targetDate.getTime() <= now.getTime()) targetDate.setDate(targetDate.getDate() + 1);
        else if (dateMatch && targetDate.getTime() < (now.getTime() - 86400000)) targetDate.setFullYear(now.getFullYear() + 1);
        const delay = targetDate.getTime() - now.getTime();
        if (delay > 0) {
            const vName = getActiveVillageName();
            browser.runtime.sendMessage({ type: "REFRESH_ALARMS", buildings: [{ name: `⭐ Resources | ${vName} ${serverTag}`, delay: delay, customType: 'manual' }] }).then(() => syncState(true));
        }
    }
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
    const minBtn = div.querySelector('#minimize-btn');
    const toggleBtn = div.querySelector('#toggle-input');
    const listContainer = div.querySelector('#timer-list');
    const presetBtn = div.querySelector('#dropdown-trigger-btn');
    const presetMenu = div.querySelector('#custom-dropdown-menu');
    const audioBtn = div.querySelector('#audio-trigger-btn');
    const audioMenu = div.querySelector('#audio-dropdown-menu');

    minBtn.onclick = () => { div.classList.toggle('is-minimized'); minBtn.innerText = div.classList.contains('is-minimized') ? '▢' : '—'; };
    presetBtn.onclick = (e) => { e.stopPropagation(); if (audioMenu) audioMenu.style.display = 'none'; presetMenu.style.display = presetMenu.style.display === 'block' ? 'none' : 'block'; };
    div.querySelector('#create-new-trigger').onclick = () => handleDropdownAction("CREATE_NEW", "");
    audioBtn.onclick = (e) => { e.stopPropagation(); if (presetMenu) presetMenu.style.display = 'none'; audioMenu.style.display = audioMenu.style.display === 'block' ? 'none' : 'block'; };
    div.querySelectorAll('.audio-option').forEach(opt => {
        opt.onclick = (e) => {
            e.stopPropagation();
            const mode = opt.dataset.mode;
            const btn = document.getElementById('audio-trigger-btn');
            if (btn) {
                if (mode === 'all') btn.innerText = "🔊";
                else if (mode === 'attacks') btn.innerText = "⚔️";
                else btn.innerText = "🔇";
                div.querySelectorAll('.audio-option').forEach(o => o.classList.remove('is-active-mode'));
                opt.classList.add('is-active-mode');
            }
            browser.runtime.sendMessage({ type: "SET_SOUND_MODE", mode: mode }).then(() => syncState());
            audioMenu.style.display = 'none';
        };
    });
    document.addEventListener('click', () => { if(presetMenu) presetMenu.style.display = 'none'; if(audioMenu) audioMenu.style.display = 'none'; });
    toggleBtn.onclick = () => {
        const nameVal = prompt("Enter Alarm Name:");
        if (!nameVal) return;
        const timeVal = prompt("Enter Duration (e.g. 15, 1:30, 0:45:00):");
        if (!timeVal) return;
        let delay = parseSmartDuration(timeVal);
        if (delay === null) { delay = calculateDelayFromSmartText(timeVal); }
        if (delay !== null && delay > 0) {
            const vName = getActiveVillageName();
            const finalName = `⭐ ${nameVal} | ${vName} ${serverTag}`;
            browser.runtime.sendMessage({ type: "REFRESH_ALARMS", buildings: [{ name: finalName, delay: delay, customType: 'manual' }] }).then(() => syncState());
        } else { alert("Invalid time format."); }
    };
    const clearBtn = div.querySelector('#clear-all');
    clearBtn.onclick = async () => { if (currentAlarms.length === 0) return; if (confirm("Clear all active timers?")) { const deletePromises = currentAlarms.map(a => browser.runtime.sendMessage({ type: "DELETE_ALARM", name: a.name })); await Promise.all(deletePromises); silencedAlarms.clear(); syncState(); } };
    return { timerWidget: div, listContainer, toggleBtn, audioBtn };
}

// REDUCED PADDING TO 5PX
const WIDGET_HTML = `
    <div style="padding: 5px; border-bottom: 1px solid #444; background: rgba(20, 20, 20, 0.95); border-radius: 8px 8px 0 0;">
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
            <button id="toggle-input" class="add-btn" title="Add Custom Alarm">+</button>
            <div id="audio-dropdown-container">
                <div id="audio-trigger-btn" title="Sound Settings">🔊</div>
                <div id="audio-dropdown-menu">
                    <div class="audio-option" data-mode="all"><span>🔊</span> All Sounds</div>
                    <div class="audio-option" data-mode="attacks"><span>⚔️</span> Attacks Only</div>
                    <div class="audio-option" data-mode="none"><span>🔇</span> Mute All</div>
                </div>
            </div>
        </div>
    </div>
    <div id="timer-list" style="padding: 0 10px; font-size: 10px; color: #ccc; max-height: 380px; overflow-y: scroll; background: rgba(30, 30, 30, 0.9); border-radius: 0 0 8px 8px;"></div>
`;

const { timerWidget, listContainer, toggleBtn, audioBtn } = createWidget();
loadShortcuts();
startLoops();