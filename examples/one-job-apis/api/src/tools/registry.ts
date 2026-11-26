// Every catalog tool and the module that runs it.
//
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";

import { TOOLS } from "@chainsafe/x402-example-one-job-catalog";

import type { JobInput } from "../input.ts";
import { run100, run25, run500 } from "./bulk.pack.ts";
import { run as csvJson } from "./csv.json.ts";
import { run as cronEnglish } from "./cron.english.ts";
import { run as hashSha256 } from "./hash.sha256.ts";
import { run as htmlText } from "./html.text.ts";
import { run as jsonCsv } from "./json.csv.ts";
import { run as jsonFmt } from "./json.fmt.ts";
import { run as jwtRead } from "./jwt.read.ts";
import { run as mimeSniff } from "./mime.sniff.ts";
import { RUNNERS } from "./runners/index.ts";
import { run as textDiff } from "./text.diff.ts";
import { run as textPii } from "./text.pii.ts";
import { run as uaParse } from "./ua.parse.ts";
import { run as unitsConvert } from "./units.convert.ts";

export interface LiveTool {
  run: (input: JobInput) => unknown | Promise<unknown>;
  file: string;
}

function source(name: string): string {
  return fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
}

const runnersFile = fileURLToPath(new URL("./runners/index.ts", import.meta.url));

const CORE: Record<string, LiveTool> = {
  "hash.sha256": { run: hashSha256, file: source("hash.sha256") },
  "json.fmt": { run: jsonFmt, file: source("json.fmt") },
  "csv.json": { run: csvJson, file: source("csv.json") },
  "json.csv": { run: jsonCsv, file: source("json.csv") },
  "text.diff": { run: textDiff, file: source("text.diff") },
  "html.text": { run: htmlText, file: source("html.text") },
  "text.pii": { run: textPii, file: source("text.pii") },
  "cron.english": { run: cronEnglish, file: source("cron.english") },
  "units.convert": { run: unitsConvert, file: source("units.convert") },
  "mime.sniff": { run: mimeSniff, file: source("mime.sniff") },
  "ua.parse": { run: uaParse, file: source("ua.parse") },
  "jwt.read": { run: jwtRead, file: source("jwt.read") },
  "bulk.25": { run: run25, file: source("bulk.pack") },
  "bulk.100": { run: run100, file: source("bulk.pack") },
  "bulk.500": { run: run500, file: source("bulk.pack") },
};

export const HANDLERS: Record<string, LiveTool> = { ...CORE };

for (const [tool, run] of Object.entries(RUNNERS)) {
  HANDLERS[tool] = { run, file: runnersFile };
}

for (const entry of TOOLS) {
  if (HANDLERS[entry.tool] === undefined) {
    throw new Error(`one-job: catalog tool ${entry.tool} has no handler`);
  }
}