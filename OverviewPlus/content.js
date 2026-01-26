// --- 1. STYLES ---
const style = document.createElement('style');
style.textContent = `
    .travian-row-total {
        /* KEY CHANGE: Push to the right side of the cell */
        float: right !important;
        /* Add a little padding from the right edge */
        
        margin-right: 0px !important;
        
        /* Visual styling to match Travian */
        font-family: Arial, Helvetica, sans-serif !important;
        font-size: 13px !important; /* 11px fits better than 13px in the list view */
        color: #333333 !important;
        cursor: default !important;
    }
`;
(document.head || document.documentElement).appendChild(style);

// --- 2. CALCULATION LOGIC ---
function calculateVillageSums() {
    const url = window.location.href;

    // --- SAFETY GUARD ---
    // 1. Must be a statistics page.
    // 2. Must NOT be Warehouse, Capacity, Culture Points, or Troops.
    // 3. Must be either the standard Resources view or Production view.
    
    // Explicitly block known "wrong" tabs to prevent summing random numbers
    if (url.includes('warehouse') || 
        url.includes('capacity') || 
        url.includes('culture') || 
        url.includes('troops')) {
        return;
    }

    // Double check: Only run if we see 'resources' or 'production' in the URL
    // (Note: The default 'statistics' page is usually resources, so we allow that too if it's not one of the blocked ones above)
    const isProduction = url.includes('production');
    
    // Select all rows
    const rows = document.querySelectorAll('tr');

    rows.forEach(row => {
        const isSumRow = row.innerText.trim().startsWith('Sum');

        // Logic: Skip "Sum" row ONLY if we are on the Production page
        if (isProduction && isSumRow) return;

        const cells = row.querySelectorAll('td');

        // Safety: Ensure table has enough columns (Name + 4 Resources + others)
        if (cells.length >= 5) {
            let rowSum = 0;
            let isReady = true;

            // Loop through columns 1-4 (Wood, Clay, Iron, Crop)
            for (let i = 1; i <= 4; i++) {
                const text = cells[i].innerText.trim();
                
                // If data is loading, stop.
                if (text.includes('...')) {
                    isReady = false;
                    break;
                }
                
                const numericText = text.replace(/[^\d]/g, '');
                
                // If a cell has text but no numbers (like a header), this isn't a resource row. Skip it.
                if (text.length > 0 && numericText.length === 0) {
                    isReady = false;
                    break;
                }

                const value = parseInt(numericText) || 0;
                rowSum += value;
            }

            // Only display if we successfully calculated a sum
            if (isReady && rowSum > 0) {
                const nameCell = cells[0];
                let display = nameCell.querySelector('.travian-row-total');
                
                if (!display) {
                    display = document.createElement('span');
                    display.className = 'travian-row-total';
                    nameCell.appendChild(display);
                }
                
                const totalString = rowSum.toLocaleString();
                
                if (display.innerText !== totalString) {
                    display.innerText = totalString;
                }
            }
        }
    });
}

// --- 3. INSTANT DETECTION ---

calculateVillageSums();

const observer = new MutationObserver((mutations) => {
    calculateVillageSums();
});

try {
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
} catch (e) {
    window.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    });
}

setInterval(calculateVillageSums, 500);
