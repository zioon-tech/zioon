export const runtimePluginApiVersion = 2;

const MAX_TOOL_OUTPUT_CHARS = 12 * 1024;

function requireObservabilityService(context) {
  const service = context.config?.observabilityService;
  if (!service?.diagnoseRun || !service?.overview || !service?.status) return null;
  return service;
}

function diagnosticForModel(diagnostic) {
  const {
    attemptId: _attemptId,
    correlation: _correlation,
    externalUrl: _externalUrl,
    ...safe
  } = diagnostic || {};
  return safe;
}

function compactLedger(ledger = {}) {
  return {
    ...ledger,
    tools: (ledger.tools || []).slice(0, 10),
    policyDenials: (ledger.policyDenials || []).slice(0, 10),
    contextFailures: (ledger.contextFailures || []).slice(0, 10),
    truncated: {
      tools: ledger.truncated?.tools === true
        || Number(ledger.counts?.tools || 0) > 10,
      policyDenials: ledger.truncated?.policyDenials === true
        || Number(ledger.counts?.policyDenials || 0) > 10,
      contextFailures: ledger.truncated?.contextFailures === true
        || Number(ledger.counts?.contextFailures || 0) > 10
    }
  };
}

function boundedContent(value) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const diagnostic = value?.diagnostic;
  const overview = value?.overview;
  if (overview) {
    const compactOverview = JSON.stringify({
      overview: {
        ...overview,
        runs: (overview.runs || []).slice(0, 10),
        truncated: true,
        outputTruncated: true
      }
    }, null, 2);
    return compactOverview.length <= MAX_TOOL_OUTPUT_CHARS
      ? compactOverview
      : JSON.stringify({
          error: "Observability result exceeded the configured output limit"
        });
  }
  if (!diagnostic) {
    return JSON.stringify({
      error: "Observability result exceeded the configured output limit"
    });
  }
  const compact = JSON.stringify({
    diagnostic: {
      schemaVersion: diagnostic.schemaVersion,
      runId: diagnostic.runId,
      attemptId: diagnostic.attemptId,
      availability: diagnostic.availability,
      source: diagnostic.source,
      correlation: diagnostic.correlation,
      traceState: diagnostic.traceState,
      coverage: diagnostic.coverage,
      ledger: compactLedger(diagnostic.ledger),
      summary: diagnostic.summary,
      largestObservedStage: diagnostic.largestObservedStage,
      counts: diagnostic.counts,
      truncated: {
        stages: diagnostic.truncated?.stages === true
          || Number(diagnostic.counts?.stages || 0) > 3,
        findings: diagnostic.truncated?.findings === true
          || Number(diagnostic.counts?.findings || 0) > 3
      },
      stages: (diagnostic.stages || []).slice(0, 3),
      findings: (diagnostic.findings || []).slice(0, 3),
      limitations: [
        ...(diagnostic.limitations || []),
        "Tool output was truncated to fit the model context limit."
      ]
    }
  }, null, 2);
  return compact.length <= MAX_TOOL_OUTPUT_CHARS
    ? compact
    : JSON.stringify({
        error: "Observability result exceeded the configured output limit",
        runId: String(diagnostic.runId || "")
      });
}

export function activateRuntimePlugin(context) {
  const service = requireObservabilityService(context);
  if (!service) {
    context.log?.(
      "info",
      "observability service is unavailable; Tool registration is disabled"
    );
    return { dispose() {} };
  }

  const registrations = [];
  registrations.push(context.tools.registerTool({
    name: "observabilityInspect",
    description: [
      "Inspect sanitized Run Ledger facts and optional trace timing for one Zion Run.",
      "Omit run_id to inspect the current Session's most recent completed Run.",
      "Run facts are authoritative; trace data only describes observed timing and relationships."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          minLength: 1,
          description: "Optional Zion Run id. Omit it to select the latest terminal Run in this Session."
        },
        include_stages: {
          type: "boolean",
          description: "Include bounded model and tool stage timing details."
        },
        include_findings: {
          type: "boolean",
          description: "Include bounded deterministic evidence findings."
        }
      },
      additionalProperties: false
    },
    policy: {
      minimumPreset: "read-only"
    },
    async invoke(args = {}, meta = {}) {
      try {
        const diagnostic = await service.diagnoseRun(args.run_id, {
          signal: meta.signal,
          requester: {
            runId: meta.runId,
            sessionId: meta.sessionId,
            projectId: meta.projectId
          },
          enforceVisibility: true,
          includeStages: args.include_stages !== false,
          includeFindings: args.include_findings !== false,
          includeExternalUrl: false
        });
        if (!diagnostic) {
          const explicitRunId = String(args.run_id || "");
          const error = explicitRunId
            ? "Run not found or not visible"
            : "No previous terminal Run is available in this Session";
          return {
            ok: false,
            error,
            content: JSON.stringify({
              error: explicitRunId ? "not-found-or-not-visible" : "no-target",
              ...(explicitRunId ? { runId: explicitRunId } : {})
            })
          };
        }
        return {
          ok: true,
          content: boundedContent({
            diagnostic: diagnosticForModel(diagnostic)
          })
        };
      } catch (error) {
        context.log?.(
          "warn",
          `observabilityInspect failed: ${error?.message || String(error)}`
        );
        return {
          ok: false,
          error: "Run diagnostics failed",
          content: JSON.stringify({
            error: "Run diagnostics failed",
            runId: String(args.run_id || "")
          })
        };
      }
    }
  }));

  registrations.push(context.tools.registerTool({
    name: "observabilityOverview",
    description: [
      "List bounded recent failed, timed out, interrupted, slow, stalled, or trace-missing Runs.",
      "The scope is fixed to the current Project, or to the current Session when no Project is available.",
      "Use observabilityInspect on selected Run ids for detailed evidence."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        window_minutes: {
          type: "integer",
          minimum: 1,
          maximum: 1440,
          description: "Lookback window in minutes. Defaults to 30."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum problem Runs to return. Defaults to 10."
        },
        min_duration_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 86400000,
          description: "Threshold used for slow and stalled signals. Defaults to 30000."
        }
      },
      additionalProperties: false
    },
    policy: {
      minimumPreset: "read-only"
    },
    async invoke(args = {}, meta = {}) {
      try {
        const overview = await service.overview({
          windowMinutes: args.window_minutes,
          limit: args.limit,
          minDurationMs: args.min_duration_ms
        }, {
          signal: meta.signal,
          requester: {
            runId: meta.runId,
            sessionId: meta.sessionId,
            projectId: meta.projectId
          }
        });
        if (!overview) {
          return {
            ok: false,
            error: "No Project or Session scope is available",
            content: JSON.stringify({ error: "no-scope" })
          };
        }
        return {
          ok: true,
          content: boundedContent({ overview })
        };
      } catch (error) {
        context.log?.(
          "warn",
          `observabilityOverview failed: ${error?.message || String(error)}`
        );
        return {
          ok: false,
          error: "Observability overview failed",
          content: JSON.stringify({ error: "Observability overview failed" })
        };
      }
    }
  }));

  context.log?.(
    "info",
    "activated with observabilityInspect and observabilityOverview Tools"
  );
  return {
    dispose() {
      for (const registration of registrations) registration.dispose();
    }
  };
}
