const { request } = require("node:https");
const { createPrivateKey, createPublicKey, createSign } = require("node:crypto");
const acme = require("acme-client");
const authority = "https://acme-v02.api.letsencrypt.org";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const network = (url, method = "GET", body) => new Promise((resolve, reject) => {
  const destination = new URL(url);
  if (destination.origin !== authority) return reject(new Error("Invalid ACME authority"));
  const req = request(destination, { method, family: 4,
    headers: { "content-type": "application/jose+json",
      ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, res => {
    const chunks = [];
    res.on("data", chunk => chunks.push(chunk));
    res.once("error", reject);
    res.once("end", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      resolve({ status: res.statusCode, headers: res.headers, data });
    });
  });
  const timer = setTimeout(() => req.destroy(new Error("ACME network timeout")), 20000);
  req.once("error", error => { clearTimeout(timer); reject(error); });
  req.end(body);
});
module.exports = async ({ domain, domains = [domain], accountKey, challengeCreate, challengeRemove, progress = () => {} }) => {
  const privateAccountKey = createPrivateKey(accountKey);
  const publicKey = createPublicKey(privateAccountKey).export({ format: "jwk" });
  const jwk = { kty: publicKey.kty, e: publicKey.e, n: publicKey.n };
  const directory = (await network(authority + "/directory")).data;
  let kid, nonce;
  const signed = async (url, payload, useJwk = false) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      nonce ||= (await network(directory.newNonce, "HEAD")).headers["replay-nonce"];
      const header = { alg: "RS256", nonce, url, ...(useJwk ? { jwk } : { kid }) };
      const protectedValue = Buffer.from(JSON.stringify(header)).toString("base64url");
      const payloadValue = payload === null ? "" : Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = createSign("SHA256").update(`${protectedValue}.${payloadValue}`)
        .sign(privateAccountKey).toString("base64url");
      progress(`ACME ${new URL(url).pathname}`);
      const response = await network(url, "POST", JSON.stringify({ protected: protectedValue, payload: payloadValue, signature }));
      nonce = response.headers["replay-nonce"];
      if (response.data?.type === "urn:ietf:params:acme:error:badNonce") continue;
      if (response.status >= 400) throw new Error(`ACME ${response.status}: ${response.data?.detail || "request rejected"}`);
      return response;
    }
    throw new Error("ACME nonce retry exhausted");
  };
  kid = (await signed(directory.newAccount, { termsOfServiceAgreed: true }, true)).headers.location;
  const order = await signed(directory.newOrder, { identifiers: domains.map(value => ({ type: "dns", value })) });
  const orderUrl = order.headers.location;
  const records = [];
  try {
    for (const authorizationUrl of order.data.authorizations) {
      let authorization = (await signed(authorizationUrl, null)).data;
      if (!domains.includes(authorization.identifier?.value)) throw new Error("Unexpected certificate authorization");
      if (authorization.status === "valid") continue;
      const challenge = authorization.challenges.find(c => c.type === "dns-01");
      if (!challenge) throw new Error("DNS certificate challenge unavailable");
      const thumbprint = require("node:crypto").createHash("sha256")
        .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest("base64url");
      const proof = require("node:crypto").createHash("sha256").update(challenge.token + "." + thumbprint).digest("base64url");
      records.push(await challengeCreate(proof, authorization.identifier.value));
      await sleep(3000);
      await signed(challenge.url, {});
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        authorization = (await signed(authorizationUrl, null)).data;
        if (authorization.status === "valid") break;
        if (authorization.status === "invalid") throw new Error(`DNS validation rejected: ${authorization.challenges.find(c => c.error)?.error?.detail || "invalid"}`);
        await sleep(3000);
      }
      if (authorization.status !== "valid") throw new Error("DNS validation timeout");
    }
    const [privateKey, csr] = await acme.forge.createCsr({ commonName: domain, altNames: domains });
    const der = csr.toString().replace(/-----[^-]+-----|\s+/g, "");
    await signed(order.data.finalize, { csr: Buffer.from(der, "base64").toString("base64url") });
    const deadline = Date.now() + 180000;
    let current;
    while (Date.now() < deadline) {
      current = (await signed(orderUrl, null)).data;
      if (current.status === "valid" && current.certificate) break;
      if (current.status === "invalid") throw new Error("Certificate order rejected");
      await sleep(3000);
    }
    if (!current?.certificate) throw new Error("Certificate issuance timeout");
    const certificate = (await signed(current.certificate, null)).data;
    return { privateKey: privateKey.toString(), certificate: String(certificate) };
  } finally {
    for (const record of records) await challengeRemove(record).catch(() => {});
  }
};
