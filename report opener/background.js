chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "open_tabs") {
        request.urls.forEach(url => {
            // Opens tabs in the background (active: false)
            chrome.tabs.create({ url: url, active: false });
        });
    }
});