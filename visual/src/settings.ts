/**
 * Format-pane settings. Report authors set these once per report.
 * NOTE: these values are stored inside the .pbix — never put secrets here.
 * Per-user secrets (proxy key) are handled in visual.ts via the LocalStorage API.
 */
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

class AgentCard extends formattingSettings.SimpleCard {
    name = "agent";              // must match "objects.agent" in capabilities.json
    displayName = "Cortex Agent";

    proxyUrl = new formattingSettings.TextInput({
        name: "proxyUrl",
        displayName: "Proxy URL",
        description: "Your Azure Function endpoint, e.g. https://pbi-cortex-chat-proxy.azurewebsites.net/api/agent",
        value: "",
        placeholder: "https://pbi-cortex-chat-proxy.azurewebsites.net/api/agent"
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

    slices = [this.proxyUrl, this.includeContext, this.maxContextRows, this.agentHint];
}

export class VisualFormattingSettingsModel extends formattingSettings.Model {
    agentCard = new AgentCard();
    cards = [this.agentCard];
}
