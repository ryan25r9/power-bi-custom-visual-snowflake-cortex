/**
 * Format-pane settings. Report authors set these once per report.
 * These values live inside the .pbix. Phase 1 has no secret to store at all —
 * the Snowflake credential is on the dataset connection, not in the visual.
 */
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

class AgentCard extends formattingSettings.SimpleCard {
    name = "agent";              // must match "objects.agent" in capabilities.json
    displayName = "Cortex Agent";

    // The visual pushes the prompt onto this column (via a Basic filter) so the
    // bound Dynamic M parameter picks it up and re-runs the answer query. These
    // must match the disconnected "binding" table you create in the model — see
    // phase1/README.md. Defaults match the README's example names.
    bindingTable = new formattingSettings.TextInput({
        name: "bindingTable",
        displayName: "Prompt binding table",
        description: "Name of the disconnected model table whose column is bound to the Dynamic M parameter.",
        value: "PromptBinding",
        placeholder: "PromptBinding"
    });

    bindingColumn = new formattingSettings.TextInput({
        name: "bindingColumn",
        displayName: "Prompt binding column",
        description: "Column in that table bound to the parameter. The prompt is written here as the selected value.",
        value: "Prompt",
        placeholder: "Prompt"
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
        placeholder: "e.g. Dining spend and usage trends by category"
    });

    slices = [this.bindingTable, this.bindingColumn, this.includeContext, this.maxContextRows, this.agentHint];
}

export class VisualFormattingSettingsModel extends formattingSettings.Model {
    agentCard = new AgentCard();
    cards = [this.agentCard];
}
