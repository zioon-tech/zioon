const { createHmac, randomUUID } = require("node:crypto");
const acme = require("acme-client");
const issueCertificate = require("./acme-client.cjs");
const FC = require("@alicloud/fc20230330");
const OpenApi = require("@alicloud/openapi-client");
const domain = "status.zioon.tech", bucket = "zioon-status-1803625616810276";
const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const query = values => Object.keys(values).sort().map(k => `${encode(k)}=${encode(values[k])}`).join("&");
async function dns(credentials, action, params) {
  const values = { Action: action, Version: "2015-01-09", Format: "JSON",
    AccessKeyId: credentials.accessKeyId, SecurityToken: credentials.securityToken,
    SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
    SignatureNonce: randomUUID(), Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...params };
  const signature = createHmac("sha1", credentials.accessKeySecret + "&")
    .update(`POST&${encode("/")}&${encode(query(values))}`).digest("base64");
  const response = await fetch("https://alidns.aliyuncs.com/", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: query({ ...values, Signature: signature }), signal: AbortSignal.timeout(20000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`DNS certificate validation failed (${value.Code || response.status})`);
  return value;
}
async function object(credentials, method, name, body, conditions = {}) {
  const date = new Date().toUTCString(), type = body ? "application/json" : "";
  const extra = { "x-oss-security-token": credentials.securityToken, ...conditions };
  const token = Object.keys(extra).filter(k => k.startsWith("x-oss-")).sort()
    .map(k => `${k}:${extra[k]}\n`).join("");
  const signature = createHmac("sha1", credentials.accessKeySecret)
    .update(`${method}\n\n${type}\n${date}\n${token}/${bucket}/${name}`).digest("base64");
  return fetch(`https://${bucket}.oss-cn-shanghai.aliyuncs.com/${name}`, { method,
    headers: { date, authorization: `OSS ${credentials.accessKeyId}:${signature}`,
      "x-oss-security-token": credentials.securityToken, ...(type ? { "content-type": type } : {}), ...conditions },
    ...(body ? { body } : {}), signal: AbortSignal.timeout(10000), redirect: "error" });
}
async function get(credentials, name) {
  const response = await object(credentials, "GET", name);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Certificate storage unavailable");
  return { value: await response.json(), etag: response.headers.get("etag") };
}
async function put(credentials, name, value, conditions) {
  const response = await object(credentials, "PUT", name, JSON.stringify(value), conditions);
  if (!response.ok) {
    const body = await response.text();
    const code = body.match(/<Code>([A-Za-z0-9_.-]+)<\/Code>/)?.[1] || "unknown";
    const message = body.match(/<Message>([^<]+)<\/Message>/)?.[1] || "";
    throw new Error(`Certificate storage write failed for ${name} (${response.status}/${code}): ${message}`);
  }
}
exports.handler = async (_event, context) => {
  const credentials = context.credentials;
  // A healthy installed certificate needs no issuance lease or ACME call.
  const installed = await get(credentials, "certificates/status/current.json");
  if (installed?.value.certificate) {
    const installedInfo = await acme.forge.readCertificateInfo(installed.value.certificate);
    const expiresAt = new Date(installedInfo.notAfter).getTime();
    if (!Number.isFinite(expiresAt)) throw new Error("Invalid certificate expiry");
    if (expiresAt > Date.now() + 30 * 86400000) {
      if (installed.value.expiresAt !== expiresAt) await put(credentials, "certificates/status/current.json",
        { ...installed.value, expiresAt });
      await put(credentials, "certificates/status/last-result.json", { ok: true, checkedAt: Date.now(), expiresAt });
      return { ok: true, expiresAt };
    }
  }
  let progress = Promise.resolve();
  acme.setLogger(message => {
    if (message.startsWith("[auto]") || message.startsWith("HTTP request:") || message.startsWith("RESP ")) {
      progress = progress.then(() => put(credentials, "certificates/status/progress.json",
        { at: Date.now(), message })).catch(() => {});
    }
  });
  const leaseName = "certificates/status/lease.json";
  const previousLease = await get(credentials, leaseName);
  if (previousLease?.value.expiresAt > Date.now()) return { ok: true, skipped: "renewal_in_progress" };
  const leaseId = randomUUID();
  await put(credentials, leaseName, { id: leaseId, expiresAt: Date.now() + 15 * 60000 },
    previousLease ? { "if-match": previousLease.etag } : { "x-oss-forbid-overwrite": "true" });
  const records = [];
  try {
    const previous = await get(credentials, "certificates/status/current.json");
    if (previous?.value.certificate) {
      const currentInfo = await acme.forge.readCertificateInfo(previous.value.certificate);
      const expiresAt = new Date(currentInfo.notAfter).getTime();
      if (!Number.isFinite(expiresAt)) throw new Error("Invalid certificate expiry");
      if (expiresAt > Date.now() + 30 * 86400000) {
        if (previous.value.expiresAt !== expiresAt) await put(credentials, "certificates/status/current.json", { ...previous.value, expiresAt });
        await put(credentials, "certificates/status/last-result.json", { ok: true, checkedAt: Date.now(), expiresAt });
        return { ok: true, expiresAt };
      }
    }
    let account = await get(credentials, "certificates/status/acme-account.json");
    if (!account) {
      account = { value: { key: (await acme.forge.createPrivateKey()).toString() } };
      await put(credentials, "certificates/status/acme-account.json", account.value);
    }
    const result = await issueCertificate({ domain, domains: ["status.zioon.tech","admin.zioon.tech","workbench.zioon.tech","mobile.zioon.tech"], accountKey: account.value.key,
      progress: message => {
        progress = progress.then(() => put(credentials, "certificates/status/progress.json",
          { at: Date.now(), message })).catch(() => {});
      },
      challengeCreate: async (value, target) => {
        const created = await dns(credentials, "AddDomainRecord", { DomainName: "zioon.tech",
          RR: `_acme-challenge.${target.split(".")[0]}`, Type: "TXT", Value: value, TTL: 600 });
        records.push(created.RecordId);
        return created.RecordId;
      },
      challengeRemove: async record => dns(credentials, "DeleteDomainRecord", { RecordId: record })
    });
    const info = await acme.forge.readCertificateInfo(result.certificate);
    const certConfig = { certName: "zioon-status-acme", ...result };
    const fc = new FC.default(new OpenApi.Config({ ...credentials, regionId: "cn-shanghai",
      endpoint: "fcv3.cn-shanghai.aliyuncs.com" }));
    const expiresAt = new Date(info.notAfter).getTime();
    await put(credentials, "certificates/status/pending.json", { ...certConfig, expiresAt });
    await fc.updateCustomDomain(domain, new FC.UpdateCustomDomainRequest({ body: {
      protocol: "HTTPS", certConfig, tlsConfig: { minVersion: "TLSv1.2", maxVersion: "TLSv1.3",
        cipherSuites: ["TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256","TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384"] },
      routeConfig: { routes: [{ path: "/*", functionName: "zioon-public-status", qualifier: "LATEST", methods: ["GET", "HEAD"] }] }
    } }));
    await put(credentials, "certificates/status/current.json", { ...certConfig, expiresAt });
    await put(credentials, "certificates/status/last-result.json", { ok: true, checkedAt: Date.now(), expiresAt });
    return { ok: true, expiresAt };
  } catch (error) {
    const message = String(error.message || error.name).slice(0, 600);
    const sanitized = message.includes(credentials.accessKeyId) || message.includes(credentials.accessKeySecret)
      || message.includes(credentials.securityToken) ? String(error.name) : message;
    await put(credentials, "certificates/status/last-result.json", { ok: false, checkedAt: Date.now(), error: sanitized }).catch(() => {});
    throw error;
  } finally {
    await progress;
    for (const record of records.splice(0)) await dns(credentials, "DeleteDomainRecord", { RecordId: record }).catch(() => {});
    const current = await get(credentials, leaseName).catch(() => null);
    if (current?.value.id === leaseId) await object(credentials, "DELETE", leaseName).catch(() => {});
  }
};
