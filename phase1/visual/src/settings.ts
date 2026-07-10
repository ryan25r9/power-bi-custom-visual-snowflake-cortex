/**
 * Format-pane settings. Report authors set these once per report.
 * These values live inside the .pbix. Phase 1 has no secret to store at all —
 * the Snowflake credential is on the dataset connection, not in the visual.
 */
import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

// Must match capabilities.json objects.agent.filterShape enumeration values.
const FILTER_SHAPES: powerbi.IEnumMember[] = [
    { displayName: "Advanced 'Is' (pane-proven)", value: "advanced" },
    { displayName: "Basic 'In' (slicer-canonical)", value: "basic" },
    { displayName: "Identity (ChicletSlicer-style; question must match a suggestion)", value: "identity" }
];

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

    // Agent runs routinely take minutes; this is only the give-up point for the
    // spinner, not a query timeout — the DirectQuery keeps running regardless.
    answerTimeout = new formattingSettings.NumUpDown({
        name: "answerTimeoutSecs",
        displayName: "Answer timeout (seconds)",
        description: "How long to wait for the answer before giving up. Agent runs can take several minutes; size this above your slowest observed run.",
        value: 600
    });

    // Backstop for input-mode auto-detection: the binding column is a zero-row
    // table, and an empty column can arrive with no metadata for the visual to
    // detect the role from. Flip this on the input-only instance if its chip
    // doesn't say "input mode".
    forceInputMode = new formattingSettings.ToggleSwitch({
        name: "forceInputMode",
        displayName: "Force input mode",
        description: "Treat this instance as the question-input box even if automatic detection fails.",
        value: false
    });

    // Research round 2026-07-10: custom-visual filters DO drive Dynamic M in
    // other setups (ChicletSlicer's Identity filters; a community date-picker's
    // Basic In on a populated column), while our Basic In on the zero-row
    // column failed live. Shape and value-membership are live variables —
    // switchable here so experiments need no rebuild.
    filterShape = new formattingSettings.ItemDropdown({
        name: "filterShape",
        displayName: "Filter shape",
        description: "How the question is applied as a filter. Identity requires the question to exactly match a suggested-question row.",
        items: FILTER_SHAPES,
        value: FILTER_SHAPES[0]
    });

    // The appended formatting instruction changes the filter value, which breaks
    // member-value tests (the value must EQUAL a suggested-question row) and the
    // Identity shape. Turn off for those.
    plainTextHint = new formattingSettings.ToggleSwitch({
        name: "plainTextHint",
        displayName: "Plain-text answer hint",
        description: "Append 'answer in plain sentences, no markdown' to every question.",
        value: true
    });

    slices = [this.bindingTable, this.bindingColumn, this.includeContext, this.maxContextRows, this.agentHint, this.answerTimeout, this.forceInputMode, this.filterShape, this.plainTextHint];
}

export class VisualFormattingSettingsModel extends formattingSettings.Model {
    agentCard = new AgentCard();
    cards = [this.agentCard];
}
