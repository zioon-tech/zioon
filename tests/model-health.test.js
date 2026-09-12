import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyModelAvailability,
  classifyModelAvailabilityError,
  getModelAvailability,
  recordModelAvailabilityFailure,
  setModelAvailability
} from "../extensions/dev.langchain-chat/model-health.js";

function createState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn((key) => values.get(key)),
    set: vi.fn((key, value) => {
      values.set(key, value);
      return value;
    })
  };
}

describe("model health", () => {
  beforeEach(() => {
    localStorage.clear();
    window.zion = {
      state: createState(),
      events: { emit: vi.fn() }
    };
  });

  it("separates permanent, transient, and request-specific failures", () => {
    expect(classifyModelAvailabilityError({ status: 401 })).toEqual({
      status: "unavailable",
      reason: "invalid_credentials",
      scope: "provider"
    });
    expect(classifyModelAvailabilityError({ status: 429 })).toEqual({
      status: "degraded",
      reason: "rate_limited",
      scope: "provider"
    });
    expect(classifyModelAvailabilityError({
      status: 400,
      message: "maximum context length exceeded"
    })).toBeNull();
  });

  it("expires a successful observation back to unknown", () => {
    setModelAvailability("provider", "model", {
      status: "available",
      reason: "request_succeeded",
      source: "actual-run",
      checkedAt: 100,
      expiresAt: 200
    }, 100);

    expect(getModelAvailability("provider", "model", 150)).toMatchObject({
      status: "available",
      stale: false
    });
    expect(getModelAvailability("provider", "model", 201)).toMatchObject({
      status: "unknown",
      reason: "stale",
      stale: true
    });
  });

  it("propagates provider credential failures across that provider only", () => {
    window.zion.state = createState({
      "models.catalog": [
        { providerId: "provider-a", id: "one" },
        { providerId: "provider-a", id: "two" },
        { providerId: "provider-b", id: "other" }
      ]
    });

    recordModelAvailabilityFailure(
      { providerId: "provider-a", modelId: "one" },
      { status: 401, message: "unauthorized" }
    );

    expect(getModelAvailability("provider-a", "one")).toMatchObject({
      status: "unavailable",
      reason: "invalid_credentials"
    });
    expect(getModelAvailability("provider-a", "two")).toMatchObject({
      status: "unavailable",
      reason: "invalid_credentials"
    });
    expect(getModelAvailability("provider-b", "other")).toMatchObject({
      status: "unknown"
    });
  });

  it("marks an incomplete local configuration without a network probe", () => {
    expect(applyModelAvailability({
      providerId: "user.dynamic",
      id: "custom",
      requiresConfig: true
    })).toMatchObject({
      availability: {
        status: "misconfigured",
        reason: "missing_key",
        source: "config"
      }
    });
  });

  it("treats a write-only Runtime credential as configured", () => {
    expect(applyModelAvailability({
      providerId: "user.dynamic",
      id: "runtime-model",
      requiresConfig: false,
      credentialConfigured: true
    }, {
      "user.dynamic::runtime-model": {
        status: "misconfigured",
        reason: "missing_key",
        source: "config"
      }
    })).toMatchObject({
      availability: {
        status: "available",
        reason: "runtime_credential_configured",
        source: "runtime-profile"
      }
    });
  });
});
