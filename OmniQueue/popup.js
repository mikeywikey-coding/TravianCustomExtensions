function loadHistory() {
    browser.storage.local.get({ history: [] }).then((data) => {
        const list = document.getElementById('historyList');
        if (data.history.length === 0) {
            list.innerHTML = "<p style='color:#666'>No buildings logged.</p>";
            return;
        }
        list.innerHTML = data.history.map(item => `
            <div class="entry">
                <strong>${item.name}</strong>
                <span class="time">Finished at: ${item.time}</span>
            </div>
        `).join('');
    });
}
document.getElementById('clear').addEventListener('click', () => {
    browser.storage.local.set({ history: [] }).then(loadHistory);
});
loadHistory();
