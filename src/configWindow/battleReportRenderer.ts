import { ipcRenderer } from 'electron';

declare global {
    interface Window {
        LocalizationManager: any;
    }
}

interface BattleReportStatus {
    slotId: string;
    date: string;
    location: string;
    winnerName: string;
    loserName: string;
    result?: string;
    status: 'pending' | 'fallback_written' | 'llm_completed' | 'error';
    error?: string;
    timestamp: number;
}

let refreshBtn: HTMLButtonElement;
let listContainer: HTMLElement;

document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('container');
    if (container) {
        container.style.display = 'block';
    }
    init();
});

async function init() {
    try {
        refreshBtn = document.getElementById('battle-report-refresh-btn') as HTMLButtonElement;
        listContainer = document.getElementById('battle-report-list') as HTMLElement;

        const config = await ipcRenderer.invoke('get-config');

        if (window.LocalizationManager) {
            await window.LocalizationManager.loadTranslations(config.language || 'en');
            window.LocalizationManager.applyTranslations();
        }

        const savedTheme = localStorage.getItem('selectedTheme') || 'original';
        document.querySelector('body')?.classList.add(`theme-${savedTheme}`);

        refreshBtn.addEventListener('click', refreshStatuses);
        ipcRenderer.on('battle-report-status-changed', refreshStatuses);

        ipcRenderer.on('update-language', async () => {
            if (window.LocalizationManager) {
                const cfg = await ipcRenderer.invoke('get-config');
                await window.LocalizationManager.loadTranslations(cfg.language || 'en');
                window.LocalizationManager.applyTranslations();
            }
            refreshStatuses();
        });

        ipcRenderer.on('update-theme', (_event, theme: string) => {
            document.querySelector('body')?.classList.remove('theme-original', 'theme-chinese', 'theme-west');
            document.querySelector('body')?.classList.add(`theme-${theme}`);
            localStorage.setItem('selectedTheme', theme);
        });

        await refreshStatuses();
    } catch (error) {
        console.error('Error in battleReport init:', error);
    }
}

async function refreshStatuses() {
    try {
        const statuses: BattleReportStatus[] = await ipcRenderer.invoke('get-battle-report-statuses');
        renderStatuses(statuses);
    } catch (error) {
        console.error('Error fetching battle report statuses:', error);
    }
}

function renderStatuses(statuses: BattleReportStatus[]) {
    if (!listContainer) return;

    if (!statuses || statuses.length === 0) {
        const noReports = window.LocalizationManager?.getNestedTranslation?.('battleReport.no_reports', null, 'No battle reports') || 'No battle reports';
        listContainer.innerHTML = `<p>${noReports}</p>`;
        return;
    }

    statuses.sort((a, b) => b.timestamp - a.timestamp);

    listContainer.innerHTML = statuses.map(s => {
        const statusLabel = window.LocalizationManager?.getNestedTranslation?.(`battleReport.status_${s.status}`, null, s.status) || s.status;
        const slotLabel = window.LocalizationManager?.getNestedTranslation?.('battleReport.slot', null, 'Slot') || 'Slot';
        const statusLabel2 = window.LocalizationManager?.getNestedTranslation?.('battleReport.status', null, 'Status') || 'Status';
        const resultLabel = s.result ? ` (${s.result})` : '';
        const errorInfo = s.error ? `<div style="color: #e74c3c; font-size: 0.85em;">${s.error}</div>` : '';
        return `
            <div class="battle-report-item" style="border: 1px solid #555; padding: 8px; margin: 4px 0; border-radius: 4px;">
                <div><strong>${slotLabel}</strong>: ${s.slotId}</div>
                <div><strong>${s.date}</strong> - ${s.location || '-'}${resultLabel}</div>
                <div>${s.winnerName || '?'} vs ${s.loserName || '?'}</div>
                <div>${statusLabel2}: <strong>${statusLabel}</strong></div>
                ${errorInfo}
            </div>
        `;
    }).join('');
}
