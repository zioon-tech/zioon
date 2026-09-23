export const OBSERVABILITY_QUERY_TOOL_NAME = "observabilityQuery";

export const OBSERVABILITY_QUERY_TOOL_DEFINITION = Object.freeze({
  name: OBSERVABILITY_QUERY_TOOL_NAME,
  description: [
    "Query this Space's sanitized observability facts with one read-only SQL statement.",
    "Available tables are obs_runs, obs_events, and obs_stages.",
    "Use parameters for values. Results, runtime, rows, and bytes are bounded.",
    "Raw tool arguments, results, errors, prompts, messages, and credentials are not present."
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        minLength: 1,
        maxLength: 16384,
        description: "One SELECT or WITH ... SELECT statement using positional ? parameters."
      },
      params: {
        type: "array",
        maxItems: 50,
        items: {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "null" }
          ]
        },
        description: "Values bound to positional ? placeholders in order."
      },
      purpose: {
        type: "string",
        enum: ["runtime_analysis", "evolution_case_build"],
        description: "Reason recorded in the account audit trail."
      }
    },
    required: ["sql", "purpose"],
    additionalProperties: false
  },
  hostKinds: ["runtime-observability"]
});
