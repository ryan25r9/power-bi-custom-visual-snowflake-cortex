/**
 * Format-pane settings. Report authors set these once per report.
 * NOTE: these values are stored inside the .pbix — never put secrets here.
 * Per-user secrets (shared key / bearer token) are handled in visual.ts via
 * the LocalStorage (storageV2) API.
 */
import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

/** Values must match the "authMode" enumeration in capabilities.json. */
export const AUTH_MODE_ITEMS: powerbi.IEnumMember[] = [
    { value: "key", displayName: "Shared key" },
    { value: "bearer", displayName: "Bearer token" }
];

class AgentCard extends formattingSettings.SimpleCard {
    name = "agent";              // must match "objects.agent" in capabilities.json
    displayName = "Cortex Agent";

    proxyUrl = new formattingSettings.TextInput({
        name: "proxyUrl",
        displayName: "Endpoint URL",
        description: "Your middleware endpoint, e.g. https://pbi-cortex-chat-proxy.azurewebsites.net/api/agent",
        value: "",
        placeholder: "https://pbi-cortex-chat-proxy.azurewebsites.net/api/agent"
    });

    authMode = new formattingSettings.ItemDropdown({
        name: "authMode",
        displayName: "Auth mode",
        description: "Shared key sends x-proxy-key; Bearer token sends an Authorization: Bearer header. Users are prompted for the credential — it is never stored in the report.",
        items: AUTH_MODE_ITEMS,
        value: AUTH_MODE_ITEMS[0]
    });

    agentProfile = new formattingSettings.TextInput({
        name: "agentProfile",
        displayName: "Agent profile",
        description: "Named agent registered on the middleware (e.g. spartan-trends). Leave blank for the middleware's default agent. Unknown names are rejected — ask the middleware owner to add a profile.",
        value: "",
        placeholder: "default"
    });

    includeContext = new formattingSettings.ToggleSwitch({
        name: "includeContext",
        displayName: "Send report context",
        description: "Include the visual's filtered data with every question",
        value: true
    });

    maxContextRows = new formattingSettings.NumUpDown({
        name: "maxContextRows",
        displayName: "Max context rows",
        description: "Cap on data rows serialized into the prompt",
        value: 200
    });

    agentHint = new formattingSettings.TextInput({
        name: "agentHint",
        displayName: "Report description",
        description: "One sentence telling the agent what this report/page is about. Prepended to every question.",
        value: "",
        placeholder: "e.g. Weekly sales performance for the Midwest region"
    });

    slices = [this.proxyUrl, this.agentProfile, this.authMode, this.includeContext, this.maxContextRows, this.agentHint];
}

class AppearanceCard extends formattingSettings.SimpleCard {
    name = "appearance";         // must match "objects.appearance" in capabilities.json
    displayName = "Appearance";

    title = new formattingSettings.TextInput({
        name: "title",
        displayName: "Title",
        description: "Header title shown at the top of the chat",
        value: "Cortex Agent",
        placeholder: "Cortex Agent"
    });

    accentColor = new formattingSettings.ColorPicker({
        name: "accentColor",
        displayName: "Accent color",
        description: "Drives buttons, links, and user-message tint",
        value: { value: "#29B5E8" }   // Snowflake blue
    });

    suggestedQuestions = new formattingSettings.TextInput({
        name: "suggestedQuestions",
        displayName: "Suggested questions",
        description: "Up to four starter questions shown on the empty state, separated by semicolons. Clicking one sends it.",
        value: "",
        placeholder: "What are the top products?; Summarize this page"
    });

    titleFontSize = new formattingSettings.NumUpDown({
        name: "titleFontSize",
        displayName: "Title text size",
        description: "Header title size in px (the ❄ logo scales with it)",
        value: 15
    });

    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "Text size",
        description: "Base chat text size in px — bubbles, chips, and cards all scale from it",
        value: 13
    });

    slices = [this.title, this.titleFontSize, this.accentColor, this.suggestedQuestions, this.fontSize];
}

export class VisualFormattingSettingsModel extends formattingSettings.Model {
    agentCard = new AgentCard();
    appearanceCard = new AppearanceCard();
    cards = [this.agentCard, this.appearanceCard];
}
