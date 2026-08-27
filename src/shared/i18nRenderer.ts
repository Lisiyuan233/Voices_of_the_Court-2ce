import { detectLanguage, Lang, normalizeLanguage, setLanguage, translateDOM, TranslationRoot } from './i18n.js';

const LANGUAGE_STORAGE_KEY = 'votc-language';

export interface IpcRendererLike {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    send(channel: string, ...args: unknown[]): void;
    on(channel: string, listener: (...args: unknown[]) => void): void;
}

export interface RendererI18nOptions {
    ipcRenderer: IpcRendererLike;
    root?: TranslationRoot;
    rerenderDynamic?: () => void;
}

export async function initRendererI18n(options: RendererI18nOptions): Promise<Lang> {
    const root = options.root || document;
    const lang = await resolveInitialLanguage(options.ipcRenderer);

    applyRendererLanguage(lang, root, options.rerenderDynamic);

    options.ipcRenderer.on('language-changed', (_event: unknown, nextLanguage: unknown) => {
        const normalized = normalizeLanguage(nextLanguage);
        if (!normalized) return;
        applyRendererLanguage(normalized, root, options.rerenderDynamic);
    });

    return lang;
}

export function setRendererLanguage(ipcRenderer: IpcRendererLike, lang: Lang): void {
    const normalized = normalizeLanguage(lang);
    if (!normalized) return;

    applyRendererLanguage(normalized, document);
    ipcRenderer.send('config-change', 'language', normalized);
}

async function resolveInitialLanguage(ipcRenderer: IpcRendererLike): Promise<Lang> {
    try {
        const config = await ipcRenderer.invoke('get-config') as { language?: unknown };
        const configLanguage = normalizeLanguage(config?.language);
        if (configLanguage) return configLanguage;
    } catch (error) {
        console.warn('Failed to read language from config:', error);
    }

    const savedLanguage = normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY));
    if (savedLanguage) return savedLanguage;

    return detectLanguage(navigator.language);
}

function applyRendererLanguage(lang: Lang, root: TranslationRoot, rerenderDynamic?: () => void): void {
    setLanguage(lang);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    translateDOM(root);
    rerenderDynamic?.();
}
