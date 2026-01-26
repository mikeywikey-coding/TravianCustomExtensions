/**
 * TRAVIAN WATCHMAN PRO - BACKGROUND SCRIPT
 * Version: 3.41
 */

let alarms = [];
let soundMode = 'all'; // 'all', 'attacks', 'none'
let ignoredAttacks = new Set(); 

// ==========================================
// CONTEXT MENU
// ==========================================
browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
        id: "add-watchman-alarm",
        title: "Add to Watchman Alarm List",
        contexts: ["all"]
    });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "add-watchman-alarm") {
        browser.tabs.sendMessage(tab.id, { 
            type: "OPEN_CONTEXT_ADD", 
            selectionText: info.selectionText || "" 
        }).catch(err => console.log("Tab not ready", err));
    }
});

// ==========================================
// AUDIO SYSTEM
// ==========================================
let audioNormal = null;
let audioAttack = null;
let isPlaying = false;
let pauseActive = false; 

const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

function initAudio() {
    if (!audioNormal) {
        audioNormal = new Audio(browser.runtime.getURL("alarm.mp3"));
        audioNormal.loop = false; 
        audioNormal.onended = () => { isPlaying = false; pauseActive = true; setTimeout(() => { pauseActive = false; }, 3000); };
    }
    if (!audioAttack) {
        audioAttack = new Audio(browser.runtime.getURL("attack.mp3"));
        audioAttack.loop = false;
        audioAttack.onended = () => { isPlaying = false; pauseActive = true; setTimeout(() => { pauseActive = false; }, 1000); };
    }
}

// Load State
browser.storage.local.get(['watchmanAlarms', 'watchmanSoundMode']).then(res => {
    if (res.watchmanAlarms) alarms = res.watchmanAlarms.map(a => ({ ...a, id: a.id || generateId(), isPinned: a.isPinned || false }));
    if (res.watchmanSoundMode) soundMode = res.watchmanSoundMode;
});

function saveState() {
    browser.storage.local.set({ watchmanAlarms: alarms, watchmanSoundMode: soundMode });
}

function startAlarmSound(type) {
    if (soundMode === 'none' || isPlaying || pauseActive) return; 
    if (soundMode === 'attacks' && type !== 'attack') return;

    initAudio();
    
    if (type === 'attack') {
        if (audioNormal && !audioNormal.paused) { audioNormal.pause(); audioNormal.currentTime = 0; }
        audioAttack.play().catch(e => console.warn(e));
    } else {
        audioNormal.play().catch(e => console.warn(e));
    }
    isPlaying = true;
}

function stopAlarmSound() {
    if (audioNormal) { audioNormal.pause(); audioNormal.currentTime = 0; }
    if (audioAttack) { audioAttack.pause(); audioAttack.currentTime = 0; }
    isPlaying = false;
    pauseActive = false; 
}

// Timer Loop
setInterval(() => {
    const now = Date.now();
    let shouldTrigger = false;
    let triggerType = 'normal'; 
    
    alarms.forEach(a => {
        if ((now >= a.scheduledTime && !a.notified && !a.silenced) || (a.notified && !a.silenced)) {
            shouldTrigger = true;
            a.notified = true; 
            if (a.customType === 'attack') triggerType = 'attack';
        }
    });

    if (shouldTrigger) {
        saveState(); 
        startAlarmSound(triggerType);
    } else {
        stopAlarmSound();
    }
}, 1000);

// Message Listener
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
        case "REFRESH_ALARMS":
            msg.buildings.forEach(newB => {
                const delay = parseInt(newB.delay);
                if (isNaN(delay) || delay <= 0) return; 

                const now = Date.now();
                const newScheduledTime = now + delay;
                
                if (newB.customType === 'attack') {
                    if (ignoredAttacks.has(newB.name)) return; 
                    const existingAttack = alarms.find(a => a.name === newB.name);
                    if (existingAttack) { existingAttack.scheduledTime = newScheduledTime; return; }
                }

                const isDuplicate = alarms.some(a => a.name === newB.name && Math.abs(a.scheduledTime - newScheduledTime) < 5000);
                if (!isDuplicate) {
                    alarms.push({
                        id: generateId(),
                        name: newB.name,
                        scheduledTime: newScheduledTime,
                        notified: false, silenced: false,
                        recurring: newB.recurring || 0,
                        customType: newB.customType || null,
                        isPinned: false 
                    });
                }
            });
            saveState();
            break;

        case "GET_ACTIVE_ALARMS":
            return Promise.resolve({ alarms, soundMode });

        case "STOP_SOUND_ONLY":
            stopAlarmSound();
            break;

        case "DELETE_ALARM":
            const target = alarms.find(a => a.id === msg.id || a.name === msg.name);
            
            // --- AUTO-CLEAR LOGIC ---
            // If the user manually clicks "Delete", we ignore future attacks on this village (standard suppression).
            // If the script sends 'autoClear: true' (because the attack ended naturally), we DO NOT suppress it.
            if (target && target.customType === 'attack' && !msg.autoClear) {
                ignoredAttacks.add(target.name);
            }

            if (msg.id) alarms = alarms.filter(a => a.id !== msg.id);
            else if (msg.name) alarms = alarms.filter(a => a.name !== msg.name);
            
            saveState();
            if (!alarms.some(a => a.notified && !a.silenced)) stopAlarmSound();
            break;
            
        case "ATTACK_CLEARED":
            if (msg.name) ignoredAttacks.delete(msg.name);
            break;

        case "EDIT_ALARM":
            const alarmToEdit = alarms.find(a => a.id === msg.id);
            if (alarmToEdit) {
                if (msg.newName) alarmToEdit.name = msg.newName;
                if (msg.newDelay) {
                    alarmToEdit.scheduledTime = Date.now() + msg.newDelay;
                    alarmToEdit.notified = false; 
                    alarmToEdit.silenced = false;
                }
                saveState();
            }
            break;

        case "TOGGLE_PIN":
            const pinTarget = alarms.find(a => a.id === msg.id);
            if (pinTarget) {
                pinTarget.isPinned = !pinTarget.isPinned;
                saveState();
            }
            break;

        case "SET_SOUND_MODE":
            soundMode = msg.mode;
            if (soundMode === 'none') stopAlarmSound();
            saveState();
            return Promise.resolve({ soundMode });
    }
});