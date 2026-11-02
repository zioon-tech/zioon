import Ajv from "ajv/dist/2020.js";
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const cache = new Map();
export function validateArgs(schema, args) {
  try {
    const key = JSON.stringify(schema);
    if (!cache.has(key)) {
      if (cache.size > 100) cache.clear();
      cache.set(key, ajv.compile(schema));
    }
    const validator = cache.get(key);
    return validator(args) ? [] : (validator.errors || []).map(error =>
      `${error.instancePath || "参数"} ${error.message}${error.params.missingProperty ? `：${error.params.missingProperty}` : ""}`);
  } catch (error) { return [`工具 schema 无法校验：${error.message}`]; }
}
