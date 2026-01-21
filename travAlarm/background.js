let alarms = [];
let isMuted = false;
let audio = null;
let isPlaying = false;
let pauseActive = false; 

const PAUSE_DURATION = 3000; 

const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

function initAudio() {
    if (!audio) {
        audio = new Audio(browser.runtime.getURL("alarm.mp3"));
        audio.loop = false; 
        audio.onended = () => {
            isPlaying = false;
            pauseActive = true;
            setTimeout(() => {
                pauseActive = false;
            }, PAUSE_DURATION);
        };
    }
}

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

function startAlarmSound() {
    if (isMuted || isPlaying || pauseActive) return; 
    initAudio();
    audio.play().catch(() => {});
    isPlaying = true;
}

function stopAlarmSound() {
    if (audio) {
        audio.pause();
        audio.currentTime = 0;
        isPlaying = false;
        pauseActive = false; 
    }
}

setInterval(() => {
    const now = Date.now();
    let shouldTrigger = false;
    
    alarms.forEach(a => {
        if (now >= a.scheduledTime && !a.notified && !a.silenced) {
            shouldTrigger = true;
            a.notified = true; 
            saveState();
        }
        if (a.notified && !a.silenced) {
            shouldTrigger = true;
        }
    });

    if (shouldTrigger) {
        startAlarmSound();
    } else {
        stopAlarmSound();
    }
}, 1000);

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
        case "REFRESH_ALARMS":
            msg.buildings.forEach(newB => {
                const delay = parseInt(newB.delay);
                if (isNaN(delay) || delay <= 0) return; 

                const now = Date.now();
                const newScheduledTime = now + delay;
                
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
                        // NEW: Store custom type (e.g., 'manual')
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
            if (msg.id) {
                alarms = alarms.filter(a => a.id !== msg.id);
            } else if (msg.name) {
                alarms = alarms.filter(a => a.name !== msg.name);
            }
            saveState();
            if (!alarms.some(a => a.notified && !a.silenced)) stopAlarmSound();
            break;

        case "TOGGLE_MUTE":
            isMuted = !isMuted;
            if (isMuted) stopAlarmSound();
            saveState();
            return Promise.resolve({ isMuted });
    }
});