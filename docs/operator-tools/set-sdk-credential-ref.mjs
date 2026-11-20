#!/usr/bin/env node
/**
 * Write one credential reference into a DSH home's managed store without
 * echoing the secret.
 *
 * The value comes from an environment variable (preferred) or a file, never
 * from argv — an argv value would land in shell history and process listings.
 * Existing `records` entries are preserved verbatim.
 *
 * Usage:
 *   node docs/operator-tools/set-sdk-credential-ref.mjs <dsh-home> <refName> --from-env VAR
 *   node docs/operator-tools/set-sdk-credential-ref.mjs <dsh-home> <refName> --from-file path
 *
 * Example (in your own terminal, so the value never reaches a chat transcript):
 *   $env:OPENCODE_GO_API_KEY = "<paste once here>"
 *   node docs/operator-tools/set-sdk-credential-ref.mjs "$env:USERPROFILE\.dsh-sdk-test" OPENCODE_GO_API_KEY --from-env OPENCODE_GO_API_KEY
 *   Remove-Item Env:OPENCODE_GO_API_KEY
 */

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [homeArg, refArg, ...rest] = process.argv.slice(2);
if (homeArg === undefined || refArg === undefined) {
  console.error("usage: set-sdk-credential-ref.mjs <dsh-home> <refName> --from-env VAR | --from-file path");
  process.exit(2);
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(refArg)) {
  console.error("refName must be a variable-name-shaped token, for example OPENCODE_GO_API_KEY");
  process.exit(2);
}

let value;
for (let index = 0; index < rest.length; index += 1) {
  const flag = rest[index];
  if (flag === "--from-env") {
    const name = rest[index + 1];
    if (name === undefined) {
      console.error("--from-env requires a variable name");
      process.exit(2);
    }
    value = process.env[name];
    index += 1;
  } else if (flag === "--from-file") {
    const file = rest[index + 1];
    if (file === undefined) {
      console.error("--from-file requires a path");
      process.exit(2);
    }
    value = (await readFile(file, "utf8")).trim();
    index += 1;
  } else {
    console.error(`unknown option ${flag}; the value is never accepted on the command line`);
    process.exit(2);
  }
}
if (typeof value !== "string" || value.trim() === "") {
  console.error("the credential value is empty; set the environment variable or file first");
  process.exit(1);
}
if (/\s/.test(value.trim())) {
  console.error("the credential value contains whitespace; refusing to write it");
  process.exit(1);
}
const secret = value.trim();

const storePath = join(homeArg, ".credentials.yaml");
const original = await readFile(storePath, "utf8");
if (!/^version:\s*1\s*$/m.test(original)) {
  console.error("the store does not declare version: 1; refusing to rewrite an unknown format");
  process.exit(1);
}
const recordsBefore = (original.match(/^ {2}[^\s:#][^:#]*:\s*$/gm) ?? []).length;

// YAML double-quoted scalar; JSON escaping is valid YAML for these values.
const literal = JSON.stringify(secret);
const lines = original.split(/\r?\n/);
const refsIndex = lines.findIndex((line) => /^refs:\s*$/.test(line));

if (refsIndex >= 0) {
  const existing = lines.findIndex(
    (line, index) => index > refsIndex && new RegExp(`^ {2}${refArg}:`).test(line),
  );
  if (existing >= 0) {
    lines[existing] = `  ${refArg}: ${literal}`;
  } else {
    let insertAt = refsIndex + 1;
    while (insertAt < lines.length && /^ {2}\S/.test(lines[insertAt])) insertAt += 1;
    lines.splice(insertAt, 0, `  ${refArg}: ${literal}`);
  }
} else {
  const recordsIndex = lines.findIndex((line) => /^records:\s*$/.test(line));
  const block = ["refs:", `  ${refArg}: ${literal}`, ""];
  if (recordsIndex >= 0) lines.splice(recordsIndex, 0, ...block);
  else lines.push(...block);
}

const updated = lines.join("\n");
const temp = `${storePath}.${process.pid}.tmp`;
await writeFile(temp, updated, { encoding: "utf8", mode: 0o600 });
await rename(temp, storePath);
await chmod(storePath, 0o600).catch(() => undefined);

const check = await readFile(storePath, "utf8");
const refsAfter = /^refs:\s*$/m.test(check);
const present = new RegExp(`^ {2}${refArg}:\\s*\\S`, "m").test(check);
const recordsAfter = (check.match(/^ {2}[^\s:#][^:#]*:\s*$/gm) ?? []).length;

console.log(
  JSON.stringify(
    {
      store: storePath,
      refName: refArg,
      refsSection: refsAfter,
      entryPresent: present,
      valueLengthClass: secret.length > 60 ? ">60" : secret.length > 30 ? "30-60" : "<30",
      recordsPreserved: recordsAfter >= recordsBefore,
      recordsBefore,
      recordsAfter,
      bytes: check.length,
    },
    null,
    2,
  ),
);
if (!present || recordsAfter < recordsBefore) process.exit(1);
