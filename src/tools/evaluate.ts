/** `jev_eval`: measure question variants against labeled examples. */

import { writeFile } from "node:fs/promises";

import { markdownTable, num, pct, preview } from "../format.ts";
import {
  choiceMetrics,
  noulMetrics,
  scoreMetrics,
  type ChoiceMetrics,
  type NoulMetrics,
  type ScoreMetrics,
} from "../metrics.ts";
import type { LoadedItem } from "../schemas.ts";
import { mapConcurrent, type Answer, type Question, type TypeSafeClient } from "../typesafe.ts";

export interface EvalArgs {
  items: LoadedItem[];
  variants: Record<string, Question>;
  model?: string | undefined;
  concurrency?: number | undefined;
  max_errors?: number | undefined;
  save_path?: string | undefined;
}

const TRUTHY = new Set(["true", "yes", "y", "1", "positive"]);
const FALSY = new Set(["false", "no", "n", "0", "negative"]);

export function toBooleanLabel(label: string | number | boolean): boolean {
  if (typeof label === "boolean") return label;
  if (typeof label === "number") return label >= 0.5;
  const normalized = label.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  throw new Error(`Label "${label}" is not a yes/no value; use true/false for a noul question.`);
}

export function toScoreLabel(label: string | number | boolean, levels: readonly string[]): number {
  if (typeof label === "number") return label;
  if (typeof label === "boolean") return label ? 1 : 0;
  const asNumber = Number(label);
  if (Number.isFinite(asNumber)) return asNumber;
  const index = levels.findIndex((level) => level.toLowerCase() === label.trim().toLowerCase());
  if (index === -1) {
    throw new Error(
      `Label "${label}" is not a level index or one of: ${levels.join(", ")}.`,
    );
  }
  return index;
}

interface ItemResult {
  id: string;
  state: unknown;
  label: string | number | boolean;
  answers: Record<string, Answer>;
}

type VariantMetrics =
  | { type: "noul"; metrics: NoulMetrics }
  | { type: "choice"; metrics: ChoiceMetrics }
  | { type: "score"; metrics: ScoreMetrics };

function headline(result: VariantMetrics): string {
  switch (result.type) {
    case "noul":
      return (
        `best F1 ${num(result.metrics.bestF1.f1, 3)} @ threshold ` +
        `${num(result.metrics.bestF1.threshold, 2)} · AUC ${num(result.metrics.auc, 3)} · ` +
        `Brier ${num(result.metrics.brier, 3)} · ECE ${num(result.metrics.ece, 3)}`
      );
    case "choice":
      return (
        `accuracy ${pct(result.metrics.accuracy)} · macro-F1 ${num(result.metrics.macroF1, 3)} · ` +
        `Brier ${num(result.metrics.brier, 3)} · ECE ${num(result.metrics.ece, 3)}`
      );
    case "score":
      return (
        `MAE ${num(result.metrics.mae, 3)} · exact ${pct(result.metrics.exactAccuracy)} · ` +
        `within 1 level ${pct(result.metrics.withinOne)}`
      );
  }
}

function noulSection(name: string, metrics: NoulMetrics, sweepStep = 0.1): string {
  const wanted = new Set<number>();
  for (let threshold = sweepStep; threshold < 1; threshold += sweepStep) {
    wanted.add(Math.round(threshold * 100) / 100);
  }
  const rows = metrics.sweep
    .filter(
      (row) =>
        wanted.has(Math.round(row.threshold * 100) / 100) ||
        row.threshold === metrics.bestF1.threshold ||
        row.threshold === metrics.bestAccuracy.threshold,
    )
    .map((row) => [
      num(row.threshold, 2) +
        (row.threshold === metrics.bestF1.threshold ? " ←best F1" : ""),
      pct(row.precision),
      pct(row.recall),
      num(row.f1, 3),
      pct(row.accuracy),
      `${row.tp}/${row.fp}/${row.fn}/${row.tn}`,
    ]);

  return [
    `### ${name}`,
    `${metrics.n} items (${metrics.positives} positive) · ${headline({ type: "noul", metrics })}`,
    markdownTable(
      ["threshold", "precision", "recall", "F1", "accuracy", "tp/fp/fn/tn"],
      rows,
    ),
  ].join("\n\n");
}

function choiceSection(name: string, metrics: ChoiceMetrics): string {
  const perClass = Object.entries(metrics.perClass)
    .filter(([, value]) => value.support > 0 || value.predicted > 0)
    .map(([className, value]) => [
      className,
      String(value.support),
      String(value.predicted),
      pct(value.precision),
      pct(value.recall),
      num(value.f1, 3),
    ]);

  const coverage = metrics.coverage.map((row) => [
    num(row.minConfidence, 2),
    pct(row.coverage),
    pct(row.accuracyOnCovered),
  ]);

  return [
    `### ${name}`,
    `${metrics.n} items · ${headline({ type: "choice", metrics })}`,
    markdownTable(["class", "support", "predicted", "precision", "recall", "F1"], perClass),
    "Abstention curve — what you keep and how right it is above a confidence floor:",
    markdownTable(["min confidence", "coverage", "accuracy on covered"], coverage),
  ].join("\n\n");
}

function scoreSection(name: string, metrics: ScoreMetrics): string {
  const coverage = metrics.coverage.map((row) => [
    num(row.minConfidence, 2),
    pct(row.coverage),
    num(row.maeOnCovered, 3),
  ]);
  return [
    `### ${name}`,
    `${metrics.n} items · ${headline({ type: "score", metrics })} · RMSE ${num(metrics.rmse, 3)}`,
    markdownTable(["min confidence", "coverage", "MAE on covered"], coverage),
  ].join("\n\n");
}

function errorSection(
  name: string,
  question: Question,
  results: readonly ItemResult[],
  metrics: VariantMetrics,
  limit: number,
): string | null {
  const scored = results
    .map((result) => {
      const answer = result.answers[name];
      if (answer === undefined) return null;
      if (answer.type === "noul" && metrics.type === "noul") {
        const label = toBooleanLabel(result.label);
        const threshold = metrics.metrics.bestF1.threshold;
        const predicted = answer.noul >= threshold;
        if (predicted === label) return null;
        return {
          id: result.id,
          severity: Math.abs(answer.noul - threshold),
          detail: `label ${label ? "yes" : "no"}, got ${answer.noul.toFixed(2)}`,
          state: result.state,
        };
      }
      if (answer.type === "choice") {
        if (answer.choice === String(result.label)) return null;
        return {
          id: result.id,
          severity: answer.confidence,
          detail: `label ${String(result.label)}, got ${answer.choice} (conf ${answer.confidence.toFixed(2)})`,
          state: result.state,
        };
      }
      if (answer.type === "score" && question.type === "score") {
        const label = toScoreLabel(result.label, question.criteria);
        const error = Math.abs(answer.score - label);
        if (error < 0.5) return null;
        return {
          id: result.id,
          severity: error,
          detail: `label ${label}, got ${answer.score.toFixed(2)}`,
          state: result.state,
        };
      }
      return null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, limit);

  if (scored.length === 0) return null;
  return [
    `Worst misses for ${name} (these are the examples to reread before rewording):`,
    markdownTable(
      ["id", "outcome", "state"],
      scored.map((entry) => [entry.id, entry.detail, preview(entry.state)]),
    ),
  ].join("\n\n");
}

export async function runEval(client: TypeSafeClient, args: EvalArgs): Promise<string> {
  const labeled = args.items.filter((item) => item.label !== undefined);
  if (labeled.length === 0) {
    throw new Error("Every item needs a `label`; jev_eval measures questions against ground truth.");
  }

  const variantNames = Object.keys(args.variants);
  const startedAt = Date.now();
  const failures: { id: string; error: string }[] = [];
  let inputTokens = 0;
  let resolvedModel = args.model ?? client.model;

  const settled = await mapConcurrent(
    labeled,
    args.concurrency ?? 8,
    async (item): Promise<ItemResult | null> => {
      try {
        const response = await client.systemOne(item.state, args.variants, args.model);
        inputTokens += response.usage.input_tokens;
        resolvedModel = response.model;
        return {
          id: item.id,
          state: item.state,
          label: item.label as string | number | boolean,
          answers: response.answers,
        };
      } catch (error) {
        failures.push({
          id: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  );

  const results = settled.filter((result): result is ItemResult => result !== null);
  if (results.length === 0) {
    throw new Error(
      `All ${labeled.length} requests failed. First error: ${failures[0]?.error ?? "unknown"}`,
    );
  }

  const elapsedMs = Date.now() - startedAt;
  const perVariant = new Map<string, VariantMetrics>();
  const sections: string[] = [];

  for (const name of variantNames) {
    const question = args.variants[name];
    if (question === undefined) continue;
    const answered = results.filter((result) => result.answers[name] !== undefined);

    if (question.type === "noul") {
      const metrics = noulMetrics(
        answered.map((result) => (result.answers[name] as { noul: number }).noul),
        answered.map((result) => toBooleanLabel(result.label)),
      );
      perVariant.set(name, { type: "noul", metrics });
      sections.push(noulSection(name, metrics));
    } else if (question.type === "choice") {
      const metrics = choiceMetrics(
        answered.map((result) => {
          const answer = result.answers[name] as {
            choice: string;
            probabilities: Record<string, number>;
            confidence: number;
          };
          return answer;
        }),
        answered.map((result) => String(result.label)),
        Object.keys(question.criteria),
      );
      perVariant.set(name, { type: "choice", metrics });
      sections.push(choiceSection(name, metrics));
    } else {
      const metrics = scoreMetrics(
        answered.map((result) => result.answers[name] as { score: number; confidence: number }),
        answered.map((result) => toScoreLabel(result.label, question.criteria)),
      );
      perVariant.set(name, { type: "score", metrics });
      sections.push(scoreSection(name, metrics));
    }

    const errors = errorSection(
      name,
      question,
      answered,
      perVariant.get(name) as VariantMetrics,
      args.max_errors ?? 8,
    );
    if (errors !== null) sections.push(errors);
  }

  const header = [
    `${results.length} labeled items · ${variantNames.length} variant(s) · ` +
      `${resolvedModel} · ${elapsedMs} ms · ${inputTokens} input tokens`,
  ];
  if (failures.length > 0) {
    header.push(`${failures.length} item(s) failed: ${preview(failures[0]?.error ?? "", 160)}`);
  }
  if (variantNames.length > 1) {
    header.push(
      markdownTable(
        ["variant", "headline metrics"],
        variantNames
          .map((name) => {
            const metrics = perVariant.get(name);
            return metrics === undefined ? null : [name, headline(metrics)];
          })
          .filter((row): row is string[] => row !== null),
      ),
    );
  }

  if (args.save_path !== undefined) {
    await writeFile(
      args.save_path,
      JSON.stringify(
        {
          model: resolvedModel,
          variants: args.variants,
          metrics: Object.fromEntries(perVariant),
          results: results.map((result) => ({
            id: result.id,
            label: result.label,
            answers: result.answers,
          })),
          failures,
        },
        null,
        2,
      ),
      "utf8",
    );
    sections.push(`Per-item results and full sweeps written to ${args.save_path}`);
  }

  sections.push(
    "Thresholds tuned here are only as good as this dataset: check that it covers the " +
      "cases you care about, and rerun after changing question wording or model version.",
  );

  return [...header, ...sections].join("\n\n");
}
