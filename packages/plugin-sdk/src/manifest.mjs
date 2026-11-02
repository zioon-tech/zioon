import { normalizePluginModels } from "./model-catalog.mjs";

export {
  TOOL_CANCELLATION_MODES,
  TOOL_EXECUTION_EFFECTS,
  TOOL_IDEMPOTENCY_MODES,
  normalizeToolExecution,
  resolveToolExecutionTimeoutMs,
  toolExecutionForDefinition
} from "./tool-execution.mjs";

export const PLUGIN_MANIFEST_VERSION = 2;
export const PLUGIN_ENTRY_KINDS = Object.freeze([
  "shared",
  "skill",
  "runtime",
  "resource",
  "renderer",
  "workbench",
  "cli"
]);
export const PLUGIN_CAPABILITY_KINDS = Object.freeze([
  "tool",
  "context",
  "post-processor",
  "controller",
  "model",
  "job",
  "resource",
  "renderer",
  "skill",
  "command"
]);
export const PLUGIN_HOST_KINDS = Object.freeze([
  "workbench",
  "runtime",
  "device",
  "cli"
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);
const LEGACY_ENTRY_ALIASES = Object.freeze({
  ui: "workbench",
  device: "resource",
  tools: "resource"
});
const COMPATIBLE_ENTRY_PATTERN = /^(?:blob:|data:|https?:|internal:)/i;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function manifestBody(manifest) {
  return isObject(manifest.zion) ? manifest.zion : manifest;
}

function normalizeEntry(value, { compatibility = false } = {}) {
  const entry = typeof value === "string" ? value.trim() : "";
  if (!entry) return "";
  if (compatibility && COMPATIBLE_ENTRY_PATTERN.test(entry)) return entry;
  if (entry.includes("\\") || entry.startsWith("/")) return "";
  const segments = entry.replace(/^\.\//, "").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "";
  }
  if (!entry.startsWith("./") && !compatibility) return "";
  return `./${segments.join("/")}`;
}

function inferredHosts(entries) {
  return {
    workbench: Boolean(entries.workbench || entries.renderer),
    runtime: Boolean(entries.runtime || entries.skill),
    device: Boolean(entries.resource),
    cli: Boolean(entries.cli)
  };
}

function validateSchemaNode(schema, path, errors, { root = false } = {}) {
  if (typeof schema === "boolean") {
    if (root) errors.push(`${path} must be an object schema`);
    return;
  }
  if (!isObject(schema)) {
    errors.push(`${path} must be a schema object`);
    return;
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    schema.type != null
    && (
      types.length === 0
      || types.some((type) => typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type))
    )
  ) {
    errors.push(`${path}.type must contain valid JSON Schema types`);
  }
  if (root && schema.type != null && !types.includes("object")) {
    errors.push(`${path}.type must include "object"`);
  }

  if (schema.properties != null && !isObject(schema.properties)) {
    errors.push(`${path}.properties must be an object`);
  }
  if (
    schema.required != null
    && (
      !Array.isArray(schema.required)
      || schema.required.some((value) => typeof value !== "string" || !value)
    )
  ) {
    errors.push(`${path}.required must be an array of non-empty strings`);
  }
  if (Array.isArray(schema.required) && isObject(schema.properties)) {
    for (const name of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, name)) {
        errors.push(`${path}.required references missing property: ${name}`);
      }
    }
  }

  if (schema.additionalProperties != null) {
    if (
      typeof schema.additionalProperties !== "boolean"
      && !isObject(schema.additionalProperties)
    ) {
      errors.push(`${path}.additionalProperties must be boolean or a schema`);
    } else if (isObject(schema.additionalProperties)) {
      validateSchemaNode(
        schema.additionalProperties,
        `${path}.additionalProperties`,
        errors
      );
    }
  }

  for (const [name, property] of Object.entries(schema.properties || {})) {
    validateSchemaNode(property, `${path}.properties.${name}`, errors);
  }

  if (schema.items != null) {
    validateSchemaNode(schema.items, `${path}.items`, errors);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (schema[keyword] == null) continue;
    if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) {
      errors.push(`${path}.${keyword} must be a non-empty schema array`);
      continue;
    }
    schema[keyword].forEach((candidate, index) => {
      validateSchemaNode(candidate, `${path}.${keyword}[${index}]`, errors);
    });
  }
  if (schema.enum != null && (!Array.isArray(schema.enum) || !schema.enum.length)) {
    errors.push(`${path}.enum must be a non-empty array`);
  }
  if (schema.pattern != null) {
    if (typeof schema.pattern !== "string") {
      errors.push(`${path}.pattern must be a string`);
    } else {
      try {
        new RegExp(schema.pattern);
      } catch {
        errors.push(`${path}.pattern must be a valid regular expression`);
      }
    }
  }
  for (const keyword of [
    "maxItems",
    "maxLength",
    "maxProperties",
    "minItems",
    "minLength",
    "minProperties"
  ]) {
    if (
      schema[keyword] != null
      && (!Number.isInteger(schema[keyword]) || schema[keyword] < 0)
    ) {
      errors.push(`${path}.${keyword} must be a non-negative integer`);
    }
  }
  for (const keyword of ["exclusiveMaximum", "exclusiveMinimum", "maximum", "minimum"]) {
    if (
      schema[keyword] != null
      && (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword]))
    ) {
      errors.push(`${path}.${keyword} must be a finite number`);
    }
  }
}

export function validateToolInputSchema(schema, path = "inputSchema") {
  const errors = [];
  validateSchemaNode(schema, path, errors, { root: true });
  return errors;
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function validateValue(value, schema, path, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${path} is not allowed`);
    return;
  }
  if (!isObject(schema)) return;

  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((candidate) => validateValue(value, candidate, path, errors));
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((candidate) => {
      const candidateErrors = [];
      validateValue(value, candidate, path, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (!matches) errors.push(`${path} must match at least one anyOf schema`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors = [];
      validateValue(value, candidate, path, candidateErrors);
      return candidateErrors.length === 0;
    }).length;
    if (matches !== 1) errors.push(`${path} must match exactly one oneOf schema`);
  }
  if (
    Array.isArray(schema.enum)
    && !schema.enum.some((candidate) => sameJsonValue(value, candidate))
  ) {
    errors.push(`${path} must be one of the declared enum values`);
  }
  if (
    Object.prototype.hasOwnProperty.call(schema, "const")
    && !sameJsonValue(value, schema.const)
  ) {
    errors.push(`${path} must equal the declared const value`);
  }

  if (schema.type != null) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path} must be ${types.join(" or ")}`);
      return;
    }
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}.${key} is required`);
      }
    }
    for (const [key, propertyValue] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateValue(propertyValue, properties[key], `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      } else if (isObject(schema.additionalProperties)) {
        validateValue(
          propertyValue,
          schema.additionalProperties,
          `${path}.${key}`,
          errors
        );
      }
    }
    if (
      Number.isInteger(schema.minProperties)
      && Object.keys(value).length < schema.minProperties
    ) {
      errors.push(`${path} must contain at least ${schema.minProperties} properties`);
    }
    if (
      Number.isInteger(schema.maxProperties)
      && Object.keys(value).length > schema.maxProperties
    ) {
      errors.push(`${path} must contain at most ${schema.maxProperties} properties`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.items != null) {
      value.forEach((item, index) => {
        validateValue(item, schema.items, `${path}[${index}]`, errors);
      });
    }
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} items`);
    }
  }

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} characters`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${path} must contain at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string" && !(new RegExp(schema.pattern)).test(value)) {
      errors.push(`${path} must match ${schema.pattern}`);
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      errors.push(`${path} must be > ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      errors.push(`${path} must be < ${schema.exclusiveMaximum}`);
    }
  }
}

export function validateToolInput(input, schema, path = "arguments") {
  const schemaErrors = validateToolInputSchema(schema);
  if (schemaErrors.length) return schemaErrors;
  if (!isObject(input)) return [`${path} must be an object`];
  const errors = [];
  validateValue(input, schema, path, errors);
  return errors;
}

export function normalizePluginSettingsSchema(input) {
  if (!isObject(input) || input.type !== "object" || input.additionalProperties !== false
    || !isObject(input.properties) || Object.keys(input.properties).length > 20
    || JSON.stringify(input).length > 16000 || validateToolInputSchema(input).length) {
    throw new Error("settingsSchema must be a bounded object schema");
  }
  for (const [key, property] of Object.entries(input.properties)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)
      || /token|secret|password|credential|authorization|api_?key/i.test(key)
      || !isObject(property) || !["string", "number", "integer", "boolean"].includes(property.type)
      || property.format || property.$ref || property.writeOnly) {
      throw new Error("Settings contain public scalar values; credentials require a Node-local connection");
    }
  }
  return JSON.parse(JSON.stringify(input));
}

export function validatePluginManifest(input, { host = "" } = {}) {
  const errors = [];
  const warnings = [];
  const manifest = isObject(input) ? input : {};
  const product = manifestBody(manifest);
  const isLegacyEnvelope = product !== manifest;
  const id = String(product.id || manifest.id || manifest.name || "").trim();
  const name = String(product.name || manifest.name || id).trim();
  const version = String(product.version || manifest.version || "").trim();
  if (!id || !ID_PATTERN.test(id)) errors.push("plugin id must be valid");
  if (!name) errors.push("plugin name is required");
  if (!version || !VERSION_PATTERN.test(version)) {
    errors.push("plugin version must be a semantic version");
  }

  const manifestVersion = Number(
    product.manifestVersion
    || manifest.manifestVersion
    || PLUGIN_MANIFEST_VERSION
  );
  if (!Number.isInteger(manifestVersion) || manifestVersion < 1) {
    errors.push("manifestVersion must be a positive integer");
  }

  const sourceEntries = isObject(product.entries) ? product.entries : {};
  const entries = {};
  for (const kind of PLUGIN_ENTRY_KINDS) {
    const explicitValue = sourceEntries[kind];
    let candidate = explicitValue;
    let compatibility = false;
    if (!candidate && kind === "workbench") {
      candidate = sourceEntries.ui || product.main || manifest.main;
      compatibility = Boolean(candidate);
    } else if (!candidate && kind === "resource") {
      candidate = sourceEntries.device || sourceEntries.tools;
      compatibility = Boolean(candidate);
    }
    const value = normalizeEntry(candidate, { compatibility });
    if (candidate && !value) {
      errors.push(`entries.${kind} must be a safe relative ./ path`);
      continue;
    }
    if (!value) continue;
    entries[kind] = value;
  }
  for (const key of Object.keys(sourceEntries)) {
    if (Object.prototype.hasOwnProperty.call(LEGACY_ENTRY_ALIASES, key)) {
      warnings.push(
        `Plugin entry "${key}" is deprecated; use `
        + `"${LEGACY_ENTRY_ALIASES[key]}"`
      );
      continue;
    }
    if (!PLUGIN_ENTRY_KINDS.includes(key)) {
      warnings.push(`Unknown plugin entry kind: ${key}`);
    }
  }
  if (
    entries.workbench
    && sourceEntries.workbench
    && sourceEntries.ui
    && sourceEntries.workbench !== sourceEntries.ui
  ) {
    warnings.push('entries.ui is ignored because entries.workbench is declared');
  }

  const declaredHosts = isObject(product.hosts)
    ? product.hosts
    : isObject(manifest.hosts)
      ? manifest.hosts
      : {};
  for (const [kind, value] of Object.entries(declaredHosts)) {
    if (!PLUGIN_HOST_KINDS.includes(kind)) {
      warnings.push(`Unknown plugin host kind: ${kind}`);
    } else if (typeof value !== "boolean") {
      errors.push(`hosts.${kind} must be boolean`);
    }
  }
  const inferred = inferredHosts(entries);
  const hosts = {
    ...inferred,
    ...Object.fromEntries(
      PLUGIN_HOST_KINDS
        .filter((kind) => typeof declaredHosts[kind] === "boolean")
        .map((kind) => [kind, declaredHosts[kind]])
    )
  };
  for (const kind of PLUGIN_HOST_KINDS) {
    if (inferred[kind] && hosts[kind] === false) {
      errors.push(`hosts.${kind} cannot be false while its entry is declared`);
    }
  }
  if (host && PLUGIN_HOST_KINDS.includes(host) && !hosts[host]) {
    errors.push(`Plugin is not compatible with the ${host} host`);
  }

  const sourceCapabilities = product.capabilities ?? manifest.capabilities;
  const capabilities = [];
  if (sourceCapabilities != null && !Array.isArray(sourceCapabilities)) {
    errors.push("capabilities must be an array");
  }
  const capabilityKeys = new Set();
  for (const [index, inputCapability] of (
    Array.isArray(sourceCapabilities) ? sourceCapabilities : []
  ).entries()) {
    const capability = isObject(inputCapability) ? inputCapability : {};
    const capabilityId = String(capability.id || "").trim();
    const kind = String(capability.kind || "").trim();
    const capabilityHost = String(capability.host || "").trim();
    if (!capabilityId || !ID_PATTERN.test(capabilityId)) {
      errors.push(`capabilities[${index}].id is invalid`);
    }
    if (!PLUGIN_CAPABILITY_KINDS.includes(kind)) {
      errors.push(`capabilities[${index}].kind is invalid`);
    }
    if (!PLUGIN_HOST_KINDS.includes(capabilityHost)) {
      errors.push(`capabilities[${index}].host is invalid`);
    } else if (!hosts[capabilityHost]) {
      errors.push(
        `capabilities[${index}] targets incompatible host: ${capabilityHost}`
      );
    }
    const capabilityKey = `${capabilityHost}:${kind}:${capabilityId}`;
    if (capabilityKeys.has(capabilityKey)) {
      errors.push(`capabilities[${index}] duplicates ${capabilityKey}`);
    }
    capabilityKeys.add(capabilityKey);
    let models;
    if (capability.required !== undefined && typeof capability.required !== "boolean") {
      errors.push(`capabilities[${index}].required must be boolean`);
    }
    if (capability.models !== undefined) {
      try {
        if (kind !== "model") throw new Error("kind");
        models = normalizePluginModels(capability.models);
      } catch { errors.push(`capabilities[${index}].models is invalid`); }
    }
    if (
      capability.requiredScopes != null
      && (
        !Array.isArray(capability.requiredScopes)
        || capability.requiredScopes.some(
          (scope) => typeof scope !== "string" || !scope.trim()
        )
      )
    ) {
      errors.push(`capabilities[${index}].requiredScopes must be strings`);
    }
    capabilities.push({
      id: capabilityId,
      kind,
      host: capabilityHost,
      ...(capability.required !== undefined ? { required: capability.required } : {}),
      ...(models ? { models } : {}),
      ...(typeof capability.risk === "string" && capability.risk.trim()
        ? { risk: capability.risk.trim() }
        : {}),
      requiredScopes: Array.isArray(capability.requiredScopes)
        ? capability.requiredScopes.map((scope) => scope.trim()).filter(Boolean)
        : []
    });
  }

  const compatibility = isObject(product.compatibility)
    ? product.compatibility
    : isObject(manifest.compatibility)
      ? manifest.compatibility
      : {};
  const runtimeApiVersion = Number(
    product.runtime?.apiVersion
    ?? compatibility.pluginApi
    ?? 1
  );
  if (!Number.isInteger(runtimeApiVersion) || runtimeApiVersion < 1) {
    errors.push("runtime.apiVersion must be a positive integer");
  }
  let settingsSchema, connection;
  if (product.settingsSchema !== undefined) {
    try { settingsSchema = normalizePluginSettingsSchema(product.settingsSchema); }
    catch (error) { errors.push(error.message); }
  }
  if (product.connection !== undefined) {
    const value = product.connection;
    if (!isObject(value) || Object.keys(value).some((k) => !["label", "envKeys", "required"].includes(k))
      || typeof value.label !== "string" || !value.label.trim() || value.label.length > 128
      || !Array.isArray(value.envKeys) || value.envKeys.length > 20
      || value.envKeys.some((k) => typeof k !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(k))
      || (value.required !== undefined && typeof value.required !== "boolean")) {
      errors.push("connection must declare a label and bounded credential environment keys");
    } else connection = { label: value.label, envKeys: [...new Set(value.envKeys)], required: value.required === true };
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalized: {
      manifestVersion,
      id,
      name,
      version,
      entries,
      hosts,
      capabilities,
      ...(settingsSchema ? { settingsSchema } : {}),
      ...(connection ? { connection } : {}),
      runtimeApiVersion,
      legacyEnvelope: isLegacyEnvelope
    }
  };
}

export function normalizePluginManifest(input, options) {
  const result = validatePluginManifest(input, options);
  if (!result.valid) {
    throw new Error(`Invalid Zion plugin manifest: ${result.errors.join("; ")}`);
  }
  return result.normalized;
}
