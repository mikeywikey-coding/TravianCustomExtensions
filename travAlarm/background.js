/**
 * TRAVIAN WATCHMAN PRO - BACKGROUND SCRIPT
 * Version: 2.5 (Context Menu Support)
 */

let alarms = [];
let isMuted = false;
let ignoredAttacks = new Set(); 

// ==========================================
// CONTEXT MENU SETUP
// ==========================================
// Create the right-click menu item
browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
        id: "add-watchman-alarm",
        title: "Add to Watchman Alarm List",
        contexts: ["selection"]
    });
});

// Handle the click event
browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "add-watchman-alarm" && info.selectionText) {
        // Send the selected text to the content script for parsing
        // We do it there because content.js knows the Village Name and Server Tag
        browser.tabs.sendMessage(tab.id, { 
            type: "PARSE_CONTEXT_ALARM", 
            text: info.selectionText 
        });
    }
});

// ==========================================
// AUDIO CONFIGURATION
// ==========================================
let audioNormal = null;
let audioAttack = null;
let isPlaying = false;
let pauseActive = false; 

const PAUSE_NORMAL = 3000;
const PAUSE_ATTACK = 1000;

const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

function initAudio() {
    if (!audioNormal) {
        audioNormal = new Audio(browser.runtime.getURL("alarm.mp3"));
        audioNormal.loop = false; 
        audioNormal.onended = () => {
            isPlaying = false;
            pauseActive = true;
            setTimeout(() => { pauseActive = false; }, PAUSE_NORMAL);
        };
    }
    if (!audioAttack) {
        audioAttack = new Audio(browser.runtime.getURL("attack.mp3"));
        audioAttack.loop = false;
        audioAttack.onended = () => {
            isPlaying = false;
            pauseActive = true;
            setTimeout(() => { pauseActive = false; }, PAUSE_ATTACK);
        };
    }
}

// Load saved state
browser.storage.local.get(['watchmanAlarms', 'watchmanMuted']).then(res => {
    if (res.watchmanAlarms) {
        alarms = res.watchmanAlarms.map(a => ({
            ...a,
            id: a.id || generateId() 
        }));
    }
    if (res.watchmanMuted !== undefined) isMuted = res.watchmanMuted;
    saveState();
});

function saveState() {
    browser.storage.local.set({ watchmanAlarms: alarms, watchmanMuted: isMuted });
}

function startAlarmSound(type) {
    if (isMuted || isPlaying || pauseActive) return; 
    
    initAudio();
    
    if (type === 'attack') {
        if (audioNormal && !audioNormal.paused) {
            audioNormal.pause();
            audioNormal.currentTime = 0;
        }
        audioAttack.play().catch(e => console.warn("Attack Audio Error:", e));
    } else {
        audioNormal.play().catch(e => console.warn("Normal Audio Error:", e));
    }
    
    isPlaying = true;
}

function stopAlarmSound() {
    if (audioNormal) {
        audioNormal.pause();
        audioNormal.currentTime = 0;
    }
    if (audioAttack) {
        audioAttack.pause();
        audioAttack.currentTime = 0;
    }
    isPlaying = false;
    pauseActive = false; 
}

// Main Timer Loop
setInterval(() => {
    const now = Date.now();
    let shouldTrigger = false;
    let triggerType = 'normal'; 
    
    alarms.forEach(a => {
        if ((now >= a.scheduledTime && !a.notified && !a.silenced) || (a.notified && !a.silenced)) {
            shouldTrigger = true;
            a.notified = true; 
            
            if (a.customType === 'attack') {
                triggerType = 'attack';
            }
        }
    });

    if (shouldTrigger) {
        saveState(); 
        startAlarmSound(triggerType);
    } else {
        stopAlarmSound();
    }
}, 1000);

// Message Handler
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
                    if (existingAttack) {
                        existingAttack.scheduledTime = newScheduledTime;
                        return; 
                    }
                }

                const isDuplicate = alarms.some(a => 
                    a.name === newB.name && 
                    Math.abs(a.scheduledTime - newScheduledTime) < 5000
                );

                if (!isDuplicate) {
                    alarms.push({
                        id: generateId(),
                        name: newB.name,
                        scheduledTime: newScheduledTime,
                        notified: false,
                        silenced: false,
                        recurring: newB.recurring || 0,
                        customType: newB.customType || null 
                    });
                }
            });
            saveState();
            break;

        case "GET_ACTIVE_ALARMS":
            return Promise.resolve({ alarms, isMuted });

        case "STOP_SOUND_ONLY":
            stopAlarmSound();
            break;

        case "SILENCE_ALARM":
            let alarmToSilence = alarms.find(a => a.id === msg.id);
            if (!alarmToSilence && msg.name) {
                alarmToSilence = alarms.find(a => a.name === msg.name);
            }
            if (alarmToSilence) {
                alarmToSilence.silenced = true;
                alarmToSilence.notified = true;
                saveState();
                stopAlarmSound();
            }
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

        case "DELETE_ALARM":
            const target = alarms.find(a => a.id === msg.id || a.name === msg.name);
            if (target && target.customType === 'attack') {
                ignoredAttacks.add(target.name);
            }

            if (msg.id) {
                alarms = alarms.filter(a => a.id !== msg.id);
            } else if (msg.name) {
                alarms = alarms.filter(a => a.name !== msg.name);
            }
            saveState();
            if (!alarms.some(a => a.notified && !a.silenced)) stopAlarmSound();
            break;
            
        case "ATTACK_CLEARED":
            if (msg.name) {
                ignoredAttacks.delete(msg.name);
            }
            break;

        case "TOGGLE_MUTE":
            isMuted = !isMuted;
            if (isMuted) stopAlarmSound();
            saveState();
            return Promise.resolve({ isMuted });
    }
});