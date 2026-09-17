/** Shared zod schemas for tool inputs and dataset loading. */

import { readFile } from "node:fs/promises";
import { z } from "zod";

import type { JsonValue, Question } from "./typesafe.ts";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const noulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string().min(1).describe("The yes/no question to evaluate."),
  criteria: z
    .object({ true: z.string().optional(), false: z.string().optional() })
    .optional()
    .describe("Optional descriptions of what a yes and a no mean."),
});

export const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().min(1).describe("What the model should decide."),
  criteria: z
    .record(z.string(), z.string().nullable())
    .describe(
      "Option name to rubric description; null when an option needs no detail. " +
        "Include a no-match option when the list may not cover every input.",
    ),
});

export const scoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string().min(1).describe("What the model should rate."),
  criteria: z
    .array(z.string())
    .min(2)
    .describe("Ordered level descriptions, lowest first. Each must stand on its own."),
});

export const questionSchema = z.discriminatedUnion("type", [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);

export const questionMapSchema = z
  .record(z.string(), questionSchema)
  .refine((questions) => Object.keys(questions).length > 0, "Provide at least one question.");

export type QuestionInput = z.infer<typeof questionSchema>;

export function toQuestion(question: QuestionInput): Question {
  return question as Question;
}

export const datasetItemSchema = z.object({
  id: z.string().optional(),
  state: jsonValueSchema,
  label: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export type DatasetItem = z.infer<typeof datasetItemSchema>;

export interface LoadedItem {
  id: string;
  state: JsonValue;
  label?: string | number | boolean;
}

/**
 * Reads items from `.jsonl` (one object per line) or `.json` (an array, or an
 * object with an `items` array).
 */
export async function loadDatasetFile(path: string): Promise<DatasetItem[]> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = path.endsWith(".jsonl") || path.endsWith(".ndjson")
    ? raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            throw new Error(`${path}: line ${index + 1} is not valid JSON.`);
          }
        })
    : JSON.parse(raw);

  const items = Array.isArray(parsed)
    ? parsed
    : (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    throw new Error(`${path}: expected an array of items or an object with an "items" array.`);
  }
  return items.map((item, index) => {
    const result = datasetItemSchema.safeParse(item);
    if (!result.success) {
      throw new Error(`${path}: item ${index} is invalid — ${result.error.issues[0]?.message}`);
    }
    return result.data;
  });
}

export async function resolveItems(
  inline: DatasetItem[] | undefined,
  path: string | undefined,
): Promise<LoadedItem[]> {
  if ((inline === undefined || inline.length === 0) && path === undefined) {
    throw new Error("Provide either `items` or `dataset_path`.");
  }
  const items = path === undefined ? (inline ?? []) : await loadDatasetFile(path);
  return items.map((item, index) => ({
    id: item.id ?? String(index),
    state: item.state,
    ...(item.label === undefined ? {} : { label: item.label }),
  }));
}
