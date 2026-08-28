import {ipcRenderer } from 'electron';
import { Config } from '../../shared/Config';

const template = document.createElement("template");

function defineTemplate(label: string){
    return `
    <link rel="stylesheet" href="../../public/configWindow/config.css">
    <style>
    </style>
    <input type="checkbox" name="awd" id="checkbox">
    <label for="awd">${label}</label>`
}

    

class ConfigCheckbox extends HTMLElement{
    label: string;
    confID: string;
    shadow: any;
    checkbox: any;
    labelElement: any;

    constructor(){
        super();
        this.label = this.getAttribute("label") || "";
        this.confID = this.getAttribute("confID")!;

        this.shadow = this.attachShadow({mode: "open"});
        template.innerHTML = defineTemplate(this.label);
        this.shadow.append(template.content.cloneNode(true));
        this.checkbox = this.shadow.querySelector("input");
        this.labelElement = this.shadow.querySelector("label");
    }


    static get observedAttributes(){
        return ["name", "confID", "label", "data-i18n"]
    }

    async connectedCallback(){
        const confID: string = this.confID;

        let config = await ipcRenderer.invoke('get-config');

        //@ts-ignore
        this.checkbox.checked = this.resolveConfigValue(config, confID); // Default to true

        this.checkbox.addEventListener("change", (e: any) => {
            console.log(confID)

            ipcRenderer.send('config-change', confID, this.checkbox.checked);
        });

        // Handle localization
        const i18nKey = this.getAttribute('data-i18n');
        if (i18nKey) {
            this.updateTranslation(i18nKey);
            
            // Listen for language changes
            ipcRenderer.on('update-language', () => {
                this.updateTranslation(i18nKey);
            });
        }
    }

    // P5: dotted confIDs (e.g. "saveFacts.enabled") address nested config
    // bags; a missing path still falls back to the legacy checked-by-default.
    public resolveConfigValue(config: any, confID: string): boolean {
        const parts = confID.split('.');
        let value: any = config;
        for (const part of parts) {
            if (value === undefined || value === null) {
                return true;
            }
            value = value[part];
        }
        return value !== undefined ? value : true;
    }

    public updateTranslation(key?: string) {
        const i18nKey = key || this.getAttribute('data-i18n');
        if (!i18nKey) return;

        // @ts-ignore
        if (window.LocalizationManager) {
            // @ts-ignore
            const translation = window.LocalizationManager.getNestedTranslation(i18nKey);
            if (translation) {
                this.labelElement.textContent = translation;
            } else if (this.label) {
                this.labelElement.textContent = this.label;
            }
        } else if (this.label) {
            this.labelElement.textContent = this.label;
        }
    }
}




customElements.define("config-checkbox", ConfigCheckbox);
