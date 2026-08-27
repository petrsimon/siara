#!/usr/bin/env node
/**
 * Read Clowder cdappconfig.json and print shell `export` lines for Litestream.
 * Usage: eval "$(node scripts/clowder-env.mjs /cdappconfig.json)"
 */
import { readFileSync } from "node:fs";

const configPath = process.argv[2];
if (!configPath) {
  process.exit(0);
}

const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const objectStore = cfg.objectStore;
if (!objectStore?.buckets?.length) {
  process.exit(0);
}

const bucket = objectStore.buckets[0];
const accessKey = bucket.accessKey ?? objectStore.accessKey;
const secretKey = bucket.secretKey ?? objectStore.secretKey;
const bucketName = bucket.name ?? bucket.requestedName;
if (!bucketName || !accessKey || !secretKey) {
  process.exit(0);
}

const scheme = objectStore.tls ? "https" : "http";
const endpoint = `${scheme}://${objectStore.hostname}:${objectStore.port}`;

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const lines = [
  `export LITESTREAM_ACCESS_KEY_ID=${shQuote(accessKey)}`,
  `export LITESTREAM_SECRET_ACCESS_KEY=${shQuote(secretKey)}`,
  `export LITESTREAM_ENDPOINT=${shQuote(endpoint)}`,
  `export REPLICA_URL=${shQuote(`s3://${bucketName}/siara`)}`,
];

console.log(lines.join("\n"));
