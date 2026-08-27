const { ipcRenderer } = require('electron');
const { t } = require('../../dist/shared/i18n.js');
const { initRendererI18n } = require('../../dist/shared/i18nRenderer.js');
const { marked } = require('marked');
const DOMPurify = require('dompurify');

// Configure marked for chronicle prose: GFM-friendly, no headings auto-IDs,
// no raw HTML pass-through. Sync mode keeps renderEntry() simple and matches
// the existing textContent fallback for callers that don't await.
marked.setOptions({
    gfm: true,
    breaks: false,
    async: false
});

const CHRONICLE_SANITIZE_CONFIG = {
    USE_PROFILES: { html: true }
};

// DOM elements
const playerIdInput = document.getElementById('playerId');
const checkpointValue = document.getElementById('checkpointValue');
const periodList = document.getElementById('periodList');
const entryMeta = document.getElementById('entryMeta');
const entryContent = document.getElementById('entryContent');
const entryScroll = document.getElementById('entryScroll');
const attemptStatus = document.getElementById('attemptStatus');
const sourceDrawer = document.getElementById('sourceDrawer');
const sourceList = document.getElementById('sourceList');
const generateBtn = document.getElementById('generateBtn');
const exportTimelineBtn = document.getElementById('exportTimelineBtn');
const retryBtn = document.getElementById('retryBtn');
const regenerateBtn = document.getElementById('regenerateBtn');
const refreshBtn = document.getElementById('refreshBtn');
const closeBtn = document.getElementById('closeBtn');
const toggleDrawerBtn = document.getElementById('toggleDrawerBtn');
const statusMessage = document.getElementById('statusMessage');

let currentContext = null;
let currentEntryId = null;
let currentAttempt = null;
let isGenerating = false;
let isExporting = false;
let statusMessageTimer = null;

function normalizeUiTheme(theme) {
    return theme === 'original' || theme === 'west' ? theme : 'chinese';
}

function applyUiTheme(theme) {
    const nextTheme = normalizeUiTheme(theme);
    document.body.classList.remove('theme-original', 'theme-chinese', 'theme-west');
    document.body.classList.add(`theme-${nextTheme}`);
}

applyUiTheme(localStorage.getItem('selectedTheme'));

// Initialize
async function init() {
    try {
        await initRendererI18n({ ipcRenderer });
        const context = await ipcRenderer.invoke('get-chronicle-context');
        if (!context || !context.playerId) {
            showStatus('No chronicle context available', 'error');
            return;
        }
        currentContext = context;
        applyUiTheme(context.uiTheme || localStorage.getItem('selectedTheme'));
        playerIdInput.value = context.playerId || '—';
        checkpointValue.textContent = context.checkpointEpoch !== undefined
            ? `Epoch ${context.checkpointEpoch}`
            : '—';

        await loadEntries();
        showStatus('Chronicle data loaded', 'success');
    } catch (error) {
        showStatus('Initialization failed: ' + error.message, 'error');
    }
}

async function loadEntries() {
    try {
        const entries = await ipcRenderer.invoke('get-chronicle-entries');
        renderPeriodList(entries || []);
        if (!currentEntryId) {
            await loadLatestFailedAttempt();
        }
    } catch (error) {
        showStatus('Failed to load entries: ' + error.message, 'error');
    }
}

function renderPeriodList(entries) {
    periodList.textContent = '';

    if (!entries || entries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'placeholder';
        empty.textContent = t('chronicle.noEntries');
        periodList.appendChild(empty);
        return;
    }

    // Sort by periodEnd descending
    const sorted = [...entries].sort((a, b) =>
        (b.periodEnd?.totalDays || 0) - (a.periodEnd?.totalDays || 0)
    );

    for (const [index, entry] of sorted.entries()) {
        const item = document.createElement('div');
        item.className = 'period-item';
        item.dataset.entryId = entry.id;
        item.style.animationDelay = `${Math.min(index, 8) * 28}ms`;
        if (entry.id === currentEntryId) {
            item.classList.add('active');
        }

        const title = document.createElement('div');
        title.className = 'period-title';
        title.textContent = entry.title || `${entry.periodStart?.display || '?'} – ${entry.periodEnd?.display || '?'}`;

        const reason = document.createElement('div');
        reason.className = 'period-reason';
        reason.textContent = formatReason(entry.reason);

        const status = document.createElement('div');
        status.className = 'period-status ' + (entry.status || 'ready');
        status.textContent = entry.status === 'empty' ? '(empty)' : entry.status || 'ready';

        item.appendChild(title);
        item.appendChild(reason);
        item.appendChild(status);

        item.addEventListener('click', () => selectEntry(entry.id, item));
        periodList.appendChild(item);
    }
}

async function selectEntry(entryId, clickedItem) {
    currentEntryId = entryId;

    // Update active state in list
    const items = periodList.querySelectorAll('.period-item');
    items.forEach(item => item.classList.remove('active'));
    const selectedItem = clickedItem
        || [...items].find(item => item.dataset.entryId === entryId);
    selectedItem?.classList.add('active');

    try {
        const entry = await ipcRenderer.invoke('read-chronicle-entry', entryId);
        if (!entry) {
            renderEntryPlaceholder('Entry not found');
            return;
        }
        renderEntry(entry);
        renderSources(entry.sourceManifest || []);
        await loadAttemptStatus(entry);
    } catch (error) {
        showStatus('Failed to load entry: ' + error.message, 'error');
    }
}

function renderEntry(entry) {
    // Render meta
    entryMeta.textContent = '';

    const metaItems = [
        { label: 'Period', value: `${entry.periodStart?.display || '?'} – ${entry.periodEnd?.display || '?'}` },
        { label: 'Reason', value: formatReason(entry.reason) },
        { label: 'Revision', value: String(entry.revision || 0) },
        { label: 'Generated', value: entry.generatedAt ? new Date(entry.generatedAt).toLocaleString() : '—' }
    ];

    for (const meta of metaItems) {
        const item = document.createElement('span');
        item.className = 'meta-item';

        const label = document.createElement('span');
        label.className = 'meta-label';
        label.textContent = meta.label + ':';

        const value = document.createElement('span');
        value.textContent = ' ' + meta.value;

        item.appendChild(label);
        item.appendChild(value);
        entryMeta.appendChild(item);
    }

    // Render content as Markdown -> sanitized HTML so headings, lists,
    // blockquotes, emphasis and inline code are all readable while keeping
    // the paper background fixed and only the text scrolling.
    if (entry.content) {
        const html = renderMarkdown(entry.content);
        entryScroll.innerHTML = html;
    } else if (entry.status === 'empty') {
        renderEntryPlaceholder('No content (empty period)');
    } else {
        renderEntryPlaceholder('No content available');
    }
}

function renderEntryPlaceholder(text) {
    entryScroll.textContent = '';
    const p = document.createElement('p');
    p.className = 'placeholder';
    p.textContent = text;
    entryScroll.appendChild(p);
}

function renderMarkdown(source) {
    let rawHtml;
    try {
        rawHtml = marked.parse(source ?? '');
    } catch (error) {
        console.warn('chronicle: failed to parse markdown, falling back to plain text', error);
        return escapeHtml(source ?? '');
    }
    return DOMPurify.sanitize(rawHtml, CHRONICLE_SANITIZE_CONFIG);
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderSources(manifest) {
    sourceList.textContent = '';

    if (!manifest || manifest.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'placeholder';
        empty.textContent = t('chronicle.noSources');
        sourceList.appendChild(empty);
        return;
    }

    for (const source of manifest) {
        const item = document.createElement('div');
        item.className = 'source-item';

        if (source.gameDate?.display) {
            const date = document.createElement('time');
            date.className = 'source-date';
            date.textContent = source.gameDate.display;
            item.appendChild(date);
        }

        const title = document.createElement('div');
        title.className = 'source-title';
        title.textContent = source.title || t('chronicle.source.untitled');
        item.appendChild(title);

        const content = document.createElement('div');
        content.className = 'source-content';
        content.textContent = source.content || t('chronicle.source.contentUnavailable');
        item.appendChild(content);

        sourceList.appendChild(item);
    }
}

async function loadAttemptStatus(entry) {
    try {
        const attempts = await ipcRenderer.invoke('get-chronicle-attempts');
        if (!attempts || attempts.length === 0) {
            currentAttempt = null;
            attemptStatus.classList.remove('visible');
            updateActionButtons();
            return;
        }

        // Find attempt for this entry's period
        const attempt = attempts.find(a => a.entryId === entry.id) || attempts.find(a =>
            a.periodStartDay === entry.periodStart?.totalDays &&
            a.periodEndDay === entry.periodEnd?.totalDays
        );

        if (!attempt) {
            currentAttempt = null;
            attemptStatus.classList.remove('visible');
            updateActionButtons();
            return;
        }

        currentAttempt = attempt;
        attemptStatus.classList.add('visible');
        attemptStatus.className = 'attempt-status visible ' + attempt.status;

        if (attempt.status === 'running') {
            attemptStatus.textContent = 'Generation in progress...';
        } else if (attempt.status === 'failed') {
            attemptStatus.textContent = 'Generation failed: ' + (attempt.sanitizedErrorCode || 'unknown');
        } else if (attempt.status === 'committed') {
            attemptStatus.textContent = 'Committed';
        } else {
            attemptStatus.textContent = 'Pending';
        }
        updateActionButtons();
    } catch (error) {
        currentAttempt = null;
        attemptStatus.classList.remove('visible');
        updateActionButtons();
    }
}

async function loadLatestFailedAttempt() {
    try {
        const attempts = await ipcRenderer.invoke('get-chronicle-attempts');
        const failed = (attempts || [])
            .filter(attempt => attempt.status === 'failed')
            .sort((a, b) => String(b.completedAt || b.startedAt || '')
                .localeCompare(String(a.completedAt || a.startedAt || '')))[0];
        if (!failed) {
            currentAttempt = null;
            attemptStatus.classList.remove('visible');
            updateActionButtons();
            return;
        }
        currentAttempt = failed;
        attemptStatus.className = 'attempt-status visible failed';
        attemptStatus.textContent = 'Generation failed: '
            + (failed.sanitizedErrorCode || 'unknown');
        updateActionButtons();
    } catch {
        currentAttempt = null;
        updateActionButtons();
    }
}

function updateActionButtons() {
    retryBtn.hidden = currentAttempt?.status !== 'failed';
    retryBtn.disabled = isGenerating;
    regenerateBtn.hidden = !currentEntryId;
    regenerateBtn.disabled = isGenerating;
}

function formatReason(reason) {
    const reasons = {
        'quarterly': 'Quarterly',
        'yearly': 'Yearly',
        'manual': 'Manual',
        'backfill': 'Backfill',
        'catch_up': 'Catch up'
    };
    return reasons[reason] || reason || '—';
}

function showStatus(message, type, duration = 3000) {
    if (statusMessageTimer !== null) {
        clearTimeout(statusMessageTimer);
        statusMessageTimer = null;
    }
    statusMessage.textContent = message;
    statusMessage.className = 'status-message visible ' + type;
    if (duration > 0) {
        statusMessageTimer = setTimeout(() => {
            statusMessage.classList.remove('visible');
            statusMessageTimer = null;
        }, duration);
    }
}

// Event listeners
generateBtn.addEventListener('click', async () => {
    if (isGenerating) return;
    isGenerating = true;
    generateBtn.disabled = true;
    generateBtn.textContent = t('chronicle.generating');

    try {
        const result = await ipcRenderer.invoke('generate-chronicle-to-current-date');
        if (result.outcome === 'generated') {
            showStatus(t('chronicle.generateSuccess'), 'success');
            await loadEntries();
        } else if (result.outcome === 'empty') {
            showStatus(t('chronicle.generateEmpty'), 'info');
            await loadEntries();
        } else if (result.outcome === 'revision_available') {
            await loadEntries();
            if (result.entryId) {
                await selectEntry(result.entryId);
            }
            showStatus(t('chronicle.revisionAvailable'), 'info', 10000);
        } else if (result.outcome === 'failed') {
            showStatus(t('chronicle.generateFailed', {
                code: result.errorCode || 'unknown'
            }), 'error');
        } else {
            showStatus(t('chronicle.generateResult', {
                outcome: result.outcome
            }), 'info');
        }
    } catch (error) {
        showStatus(t('chronicle.generateError', { error: error.message }), 'error');
    } finally {
        isGenerating = false;
        generateBtn.disabled = false;
        generateBtn.textContent = t('chronicle.generate');
        updateActionButtons();
    }
});

// Export current timeline (plan T12). The renderer performs no file
// traversal, timeline filtering or ZIP work: everything happens in main.
if (exportTimelineBtn) {
    const exportTooltip = () => t('chronicle.export.tooltip');
    exportTimelineBtn.title = exportTooltip();

    exportTimelineBtn.addEventListener('click', async () => {
        if (isExporting) return;
        isExporting = true;
        exportTimelineBtn.disabled = true;
        exportTimelineBtn.setAttribute('aria-busy', 'true');
        const originalText = exportTimelineBtn.textContent;
        exportTimelineBtn.textContent = t('chronicle.export.working');

        try {
            const result = await ipcRenderer.invoke('export-current-timeline');
            if (!result || result.status === 'cancelled') {
                // Quiet restore; cancelling is not an error.
                return;
            }
            if (result.status === 'exported') {
                showStatus(
                    result.warningCount > 0
                        ? t('chronicle.export.successWithWarnings', {
                            count: result.entryCount,
                            warnings: result.warningCount
                        })
                        : t('chronicle.export.success', { path: result.targetPath }),
                    'success',
                    12000
                );
            } else {
                const code = result.error && result.error.code ? result.error.code : 'generic';
                showStatus(t(`chronicle.export.error.${code}`), 'error', 12000);
            }
        } catch (error) {
            showStatus(t('chronicle.export.error.generic'), 'error', 12000);
        } finally {
            isExporting = false;
            exportTimelineBtn.disabled = false;
            exportTimelineBtn.removeAttribute('aria-busy');
            exportTimelineBtn.textContent = originalText;
        }
    });
}

retryBtn.addEventListener('click', async () => {
    if (isGenerating || !currentAttempt?.requestKey) return;
    isGenerating = true;
    generateBtn.disabled = true;
    updateActionButtons();
    try {
        const result = await ipcRenderer.invoke(
            'retry-chronicle-attempt',
            currentAttempt.requestKey
        );
        if (result.outcome === 'generated' || result.outcome === 'empty') {
            showStatus('Generation retry completed', 'success');
            await loadEntries();
            if (result.entryId) await selectEntry(result.entryId);
        } else {
            showStatus('Retry failed: ' + (result.errorCode || result.outcome), 'error');
            await loadLatestFailedAttempt();
        }
    } catch (error) {
        showStatus('Retry error: ' + error.message, 'error');
    } finally {
        isGenerating = false;
        generateBtn.disabled = false;
        updateActionButtons();
    }
});

regenerateBtn.addEventListener('click', async () => {
    if (isGenerating || !currentEntryId) return;
    isGenerating = true;
    generateBtn.disabled = true;
    updateActionButtons();
    try {
        const result = await ipcRenderer.invoke(
            'regenerate-chronicle-entry',
            currentEntryId
        );
        if (result.outcome === 'generated' || result.outcome === 'empty') {
            showStatus('Chronicle entry regenerated', 'success');
            await loadEntries();
            await selectEntry(result.entryId || currentEntryId);
        } else {
            showStatus('Regeneration failed: ' + (result.errorCode || result.outcome), 'error');
            await loadLatestFailedAttempt();
        }
    } catch (error) {
        showStatus('Regeneration error: ' + error.message, 'error');
    } finally {
        isGenerating = false;
        generateBtn.disabled = false;
        updateActionButtons();
    }
});

refreshBtn.addEventListener('click', async () => {
    await loadEntries();
    if (currentEntryId) {
        await selectEntry(currentEntryId);
    }
    showStatus('Refreshed', 'info');
});

closeBtn.addEventListener('click', () => {
    ipcRenderer.send('close-chronicle-window');
});

toggleDrawerBtn.addEventListener('click', () => {
    sourceDrawer.classList.toggle('collapsed');
    const isCollapsed = sourceDrawer.classList.contains('collapsed');
    toggleDrawerBtn.textContent = isCollapsed ? '▶' : '◀';
    toggleDrawerBtn.setAttribute('aria-expanded', String(!isCollapsed));
});

ipcRenderer.on('update-theme', (_event, theme) => {
    const nextTheme = normalizeUiTheme(theme);
    localStorage.setItem('selectedTheme', nextTheme);
    applyUiTheme(nextTheme);
});

// Language change handler
ipcRenderer.on('language-changed', () => {
    location.reload();
});

// Initialize on load
init();
