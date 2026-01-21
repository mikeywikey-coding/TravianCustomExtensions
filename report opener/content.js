function openAllUnread() {
    const rows = document.querySelectorAll('tr');
    const links = [];

    rows.forEach((row) => {
        // 1. Only look at rows with the unread indicator
        if (row.querySelector('.messageStatusUnread')) {
            
            const allLinks = Array.from(row.querySelectorAll('a'));
            
            // 2. Find the link that has 'id=' BUT does NOT have 'build.php'
            const correctLink = allLinks.find(a => 
                a.href.includes('id=') && 
                !a.href.includes('build.php')
            );

            if (correctLink) {
                links.push(correctLink.href);
            }
        }
    });

    const uniqueLinks = [...new Set(links)];

    if (uniqueLinks.length > 0) {
        console.log(`Found ${uniqueLinks.length} valid report links.`);
        chrome.runtime.sendMessage({ action: "open_tabs", urls: uniqueLinks });
    } else {
        console.log("No valid report links found (filtered out build.php).");
    }
}

function injectButton() {
    if (document.getElementById('open-unread-btn')) return;
    const wrapper = document.querySelector('.buttonWrapper');
    const archiveBtn = document.querySelector('button.archive');
    
    if (wrapper && archiveBtn) {
        const btn = document.createElement('button');
        btn.id = 'open-unread-btn';
        btn.type = 'button';
        btn.className = 'textButtonV1 green'; 
        btn.innerText = 'Open Unread';
        btn.style.flex = '0 1 auto';
        btn.style.width = 'auto';
        btn.style.padding = '0 10px';
        btn.style.margin = '0 2px';
        btn.style.height = '25px';
        wrapper.style.display = 'flex';
        btn.onclick = (e) => {
            e.preventDefault();
            openAllUnread();
        };
        archiveBtn.after(btn);
    }
}
setInterval(injectButton, 1);