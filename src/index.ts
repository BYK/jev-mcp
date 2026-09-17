#!/usr/bin/env node
/** jev-eval-mcp: an eval-first MCP server for TypeSafe's Jev model. */

import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  datasetItemSchema,
  jsonValueSchema,
  questionMapSchema,
  questionSchema,
  resolveItems,
} from "./schemas.ts";
import { runAsk } from "./tools/ask.ts";
import { runEval } from "./tools/evaluate.ts";
import { runMap } from "./tools/map.ts";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, TypeSafeClient, type Question } from "./typesafe.ts";

const SERVER_VERSION = "0.1.0";

const modelField = z
  .string()
  .optional()
  .describe(`Model id or alias. Defaults to ${DEFAULT_MODEL}.`);

const datasetFields = {
  items: z
    .array(datasetItemSchema)
    .optional()
    .describe("Inline items: { id?, state, label? }. Use dataset_path instead for large sets."),
  dataset_path: z
    .string()
    .optional()
    .describe("Path to a .jsonl (one object per line) or .json file of items."),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(32)
    .optional()
    .describe("Requests in flight. Default 8."),
  save_path: z
    .string()
    .optional()
    .describe("Write the full per-item results as JSON here, to keep them out of context."),
};

function textResult(text: string): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function createServer(client: TypeSafeClient): McpServer {
  const server = new McpServer(
    { name: "jev-eval-mcp", version: SERVER_VERSION },
    {
      instructions:
        "Jev returns typed judgments (noul / choice / score) with calibrated probabilities. " +
        "Use jev_map to judge many items without reading them all into context, and jev_eval " +
        "to measure a question and pick a threshold from data instead of guessing one. " +
        "Do not use it as an oracle for decisions you can make yourself with better context.",
    },
  );

  server.registerTool(
    "jev_ask",
    {
      title: "Ask Jev typed questions about one state",
      description:
        "Run a question set once against a single state and see the typed answers with their " +
        "probability distributions. Use it to prototype question wording before committing it " +
        "to code or to jev_eval. Questions over the same state are answered independently in " +
        "one request, so ask several at once.",
      inputSchema: {
        state: jsonValueSchema.describe(
          "The content to judge: a string, or an object/array when it has several named parts.",
        ),
        questions: questionMapSchema.describe(
          "Map of your question id to a question. Ids are not sent to the model, so put the " +
            "full meaning in instructions.",
        ),
        model: modelField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ state, questions, model }) => {
      try {
        return textResult(
          await runAsk(client, {
            state,
            questions: questions as Record<string, Question>,
            ...(model === undefined ? {} : { model }),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jev_map",
    {
      title: "Run a question set over many items",
      description:
        "Judge every item in a list and get back one compact row per item, plus per-question " +
        "aggregates. Built for triage and ranking at a scale where reading each item into " +
        "context is the expensive part: filter, sort, or write the full results to disk and " +
        "only pull back what matters.",
      inputSchema: {
        ...datasetFields,
        questions: questionMapSchema.describe("Questions applied to every item."),
        model: modelField,
        max_rows: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Rows to include in the table. Default 50."),
        include_rows: z
          .boolean()
          .optional()
          .describe("Set false for aggregates only. Default true."),
        sort_by: z
          .string()
          .optional()
          .describe("Question id to sort by: noul value, score, or choice confidence."),
        order: z.enum(["asc", "desc"]).optional().describe("Sort direction. Default desc."),
        filter: z
          .object({
            question: z.string(),
            min: z.number().optional(),
            max: z.number().optional(),
            equals: z.string().optional(),
          })
          .optional()
          .describe("Keep rows whose answer is in a numeric range, or equals a choice option."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ items, dataset_path, questions, ...rest }) => {
      try {
        const loaded = await resolveItems(items, dataset_path);
        return textResult(
          await runMap(client, {
            items: loaded,
            questions: questions as Record<string, Question>,
            ...rest,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jev_eval",
    {
      title: "Measure question variants against labeled examples",
      description:
        "Score one or more wordings of a question against labeled items and report accuracy, " +
        "calibration (Brier, ECE, AUC), a full threshold sweep for noul questions, an " +
        "abstention curve for choice and score questions, and the worst misses. Run this " +
        "before hard-coding any threshold, and rerun it after changing wording or model " +
        "version. Variants are asked in the same request, so comparing several is nearly free.",
      inputSchema: {
        ...datasetFields,
        variants: z
          .record(z.string(), questionSchema)
          .describe(
            "Candidate questions keyed by variant name. Pass several wordings of the same " +
              "judgment to compare them head to head on identical inputs.",
          ),
        model: modelField,
        max_errors: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Worst misses to list per variant. Default 8."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ items, dataset_path, variants, ...rest }) => {
      try {
        const loaded = await resolveItems(items, dataset_path);
        return textResult(
          await runEval(client, {
            items: loaded,
            variants: variants as Record<string, Question>,
            ...rest,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const apiKey = process.env["TYPESAFE_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") {
    process.stderr.write(
      "jev-eval-mcp: TYPESAFE_API_KEY is not set. Some MCP clients filter the environment before " +
        "spawning servers; set it explicitly in the server's env block. Keys: " +
        "https://console.typesafe.ai/settings/keys\n",
    );
    process.exit(1);
  }

  const client = new TypeSafeClient({
    apiKey,
    baseUrl: process.env["TYPESAFE_BASE_URL"] ?? DEFAULT_BASE_URL,
    model: process.env["JEV_MODEL"] ?? DEFAULT_MODEL,
  });

  await createServer(client).connect(new StdioServerTransport());
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && (await realpath(entrypoint)) === fileURLToPath(import.meta.url)) {
  await main();
}
