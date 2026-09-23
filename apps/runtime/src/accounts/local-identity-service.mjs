#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  createLocalDevOidc,
  seedLocalIdentityUser
} from "./local-dev-oidc.mjs";

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function seed() {
  const password = process.env.ZION_LOCAL_IDENTITY_BOOTSTRAP_PASSWORD || await readStdin();
  const user = await seedLocalIdentityUser({
    databaseUrl: required("ZION_DATABASE_URL"),
    email: required("ZION_LOCAL_IDENTITY_BOOTSTRAP_EMAIL"),
    name: process.env.ZION_LOCAL_IDENTITY_BOOTSTRAP_NAME || "",
    password,
    verified: true
  });
  process.stdout.write(`${JSON.stringify({
    subject: user.subject,
    email: user.email,
    name: user.name,
    verified: user.verified
  }, null, 2)}\n`);
}

async function start() {
  const provider = await createLocalDevOidc({
    databaseUrl: required("ZION_DATABASE_URL"),
    host: process.env.ZION_LOCAL_IDENTITY_HOST || "127.0.0.1",
    port: Number(process.env.ZION_LOCAL_IDENTITY_PORT || "18080"),
    runtimeOrigin: required("ZION_RUNTIME_PUBLIC_URL"),
    clientId: process.env.ZION_OIDC_CLIENT_ID || "zion-runtime",
    publicIssuer: required("ZION_OIDC_ISSUER")
  });
  process.stdout.write(`local_identity_issuer=${provider.issuer}\n`);
  const stop = async () => {
    await provider.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] || "start";
  const action = command === "seed" ? seed : start;
  action().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
