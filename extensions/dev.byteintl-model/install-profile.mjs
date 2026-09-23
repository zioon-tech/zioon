import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

const DEFAULT_PROFILE_ID = "workbench.user.dynamic.gpt-6-astra";
const DEFAULT_MODEL = "gpt-6-astra";
const DEFAULT_ADAPTER_URL =
  "http://127.0.0.1:8771/v1/chat/completions";

function valueAfter(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return number;
}

function defaultProfilePath(environment) {
  if (environment.ZION_RUNTIME_MODEL_PROFILES) {
    return resolve(environment.ZION_RUNTIME_MODEL_PROFILES);
  }
  if (environment.ZION_RUNTIME_DATA_DIR) {
    return join(resolve(environment.ZION_RUNTIME_DATA_DIR), "model-profiles.json");
  }
  return join(homedir(), ".zion-next", "runtime", "model-profiles.json");
}

function normalizeAdapterUrl(value) {
  const url = new URL(String(value || DEFAULT_ADAPTER_URL));
  if (url.protocol !== "http:") {
    throw new Error("ByteIntl adapter profile URL must use loopback HTTP");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error("ByteIntl adapter profile URL must use a loopback host");
  }
  if (url.username || url.password || url.search) {
    throw new Error("ByteIntl adapter profile URL must not contain credentials or query parameters");
  }
  return url.toString();
}

async function readStore(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Model profile store must contain a JSON object");
    }
    if (parsed.profiles != null && !Array.isArray(parsed.profiles)) {
      throw new Error("Model profile store profiles must be an array");
    }
    return {
      ...parsed,
      version: Number(parsed.version) || 1,
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : []
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, profiles: [] };
    throw error;
  }
}

async function writeStore(path, store) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => {});
}

export async function installByteIntlModelProfile({
  profilePath,
  profileId = DEFAULT_PROFILE_ID,
  label = "GPT-6 Astra (ByteIntl)",
  model = DEFAULT_MODEL,
  adapterUrl = DEFAULT_ADAPTER_URL,
  maxOutputTokens = 500
} = {}) {
  const path = resolve(String(profilePath || defaultProfilePath(process.env)));
  const id = String(profileId || "").trim();
  const modelId = String(model || "").trim();
  if (!id) throw new Error("ByteIntl model profile id is required");
  if (!modelId) throw new Error("ByteIntl model id is required");
  const endpoint = normalizeAdapterUrl(adapterUrl);
  const profile = {
    id,
    label: String(label || id),
    providerId: "user.dynamic",
    sourceModelId: modelId,
    providerType: "openai",
    endpoint,
    model: modelId,
    credentialRequired: true,
    maxOutputTokens: positiveInteger(maxOutputTokens, 500),
    capabilities: {
      supportsImage: false,
      supportsThinking: false,
      preservedThinking: false,
      interleavedThinking: false
    },
    metadata: {
      description: "ByteIntl ModelHub through dev.byteintl-model",
      stream: false
    }
  };
  const store = await readStore(path);
  const index = store.profiles.findIndex((item) =>
    String(item?.id || "") === id
  );
  if (index >= 0) store.profiles[index] = profile;
  else store.profiles.push(profile);
  await writeStore(path, store);
  return {
    profilePath: path,
    profile,
    replaced: index >= 0
  };
}

function parseArgs(args, environment = process.env) {
  return {
    profilePath: valueAfter(
      args,
      "--profile-path",
      defaultProfilePath(environment)
    ),
    profileId: valueAfter(args, "--profile-id", DEFAULT_PROFILE_ID),
    label: valueAfter(args, "--label", "GPT-6 Astra (ByteIntl)"),
    model: valueAfter(
      args,
      "--model",
      environment.ZION_BYTEINTL_MODEL || DEFAULT_MODEL
    ),
    adapterUrl: valueAfter(
      args,
      "--adapter-url",
      `http://${
        environment.ZION_BYTEINTL_ADAPTER_HOST || "127.0.0.1"
      }:${
        environment.ZION_BYTEINTL_ADAPTER_PORT || "8771"
      }/v1/chat/completions`
    ),
    maxOutputTokens: valueAfter(
      args,
      "--max-output-tokens",
      environment.ZION_BYTEINTL_DEFAULT_MAX_TOKENS || "500"
    )
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await installByteIntlModelProfile(
    parseArgs(process.argv.slice(2))
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
