import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const home = process.argv[2];
if (home === undefined) {
  console.error("usage: node inspect-grant.mjs <sdk-home>");
  process.exit(2);
}
const path = join(home, ".credentials.yaml");
let raw;
try {
  raw = await readFile(path, "utf8");
} catch (error) {
  console.log(JSON.stringify({ present: false, reason: String(error?.code ?? error) }));
  process.exit(0);
}
const bytes = (await stat(path)).size;

/**
 * Structure-only inspection: record keys, kind tags, the grant's issuer host,
 * and whether a token field exists. No token, payload, or account identifier is
 * ever printed.
 */
const lines = raw.split(/\r?\n/);
const records = [];
let inRecords = false;
let current = undefined;
for (const line of lines) {
  if (/^records:\s*$/.test(line)) {
    inRecords = true;
    continue;
  }
  if (inRecords && /^\S/.test(line) && !/^records:/.test(line)) {
    // A new top-level section ends the records block.
    inRecords = false;
  }
  if (!inRecords) continue;
  const recordMatch = /^ {2}([^\s:#][^:#]*):\s*$/.exec(line);
  if (recordMatch !== null) {
    current = { key: recordMatch[1].trim(), kind: null, issuerHost: null, hasToken: false };
    records.push(current);
    continue;
  }
  if (current === undefined) continue;
  const kind = /^\s+kind:\s*(\S+)\s*$/.exec(line);
  if (kind !== null) {
    current.kind = kind[1];
    continue;
  }
  const issuer = /^\s+issuer:\s*"?([^"\s]+)"?\s*$/.exec(line);
  if (issuer !== null) {
    try {
      current.issuerHost = new URL(issuer[1]).host;
    } catch {
      current.issuerHost = "unparseable";
    }
    continue;
  }
  const token = /^\s+token:\s*(\S+)\s*$/.exec(line);
  if (token !== null) current.hasToken = true;
}

const refKeys = [];
{
  let inRefs = false;
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (inRefs && /^\S/.test(line)) inRefs = false;
    if (!inRefs) continue;
    const key = /^ {2}([^\s:#][^:#]*):/.exec(line);
    if (key !== null) refKeys.push(key[1].trim());
  }
}

console.log(
  JSON.stringify(
    {
      present: true,
      bytes,
      version1: /^version:\s*1\s*$/m.test(raw),
      refKeys,
      records: records.map((record) => ({
        key: record.key,
        kind: record.kind,
        issuerHost: record.issuerHost,
        hasToken: record.hasToken,
      })),
    },
    null,
    2,
  ),
);
