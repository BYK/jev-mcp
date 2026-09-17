/** `jev_map`: run one question set over many items and return a compact table. */

import { writeFile } from "node:fs/promises";

import { markdownTable, num, preview } from "../format.ts";
import type { LoadedItem } from "../schemas.ts";
import { mapConcurrent, type Answer, type Question, type TypeSafeClient } from "../typesafe.ts";

export interface MapFilter {
  question: string;
  min?: number | undefined;
  max?: number | undefined;
  equals?: string | undefined;
}

export interface MapArgs {
  items: LoadedItem[];
  questions: Record<string, Question>;
  model?: string | undefined;
  concurrency?: number | undefined;
  max_rows?: number | undefined;
  sort_by?: string | undefined;
  order?: "asc" | "desc" | undefined;
  filter?: MapFilter | undefined;
  include_rows?: boolean | undefined;
  save_path?: string | undefined;
}

interface Row {
  id: string;
  state: unknown;
  answers: Record<string, Answer>;
}

interface Failure {
  id: string;
  error: string;
}

/** The number a row is sorted and filtered by, per answer type. */
export function answerValue(answer: Answer): number {
  switch (answer.type) {
    case "noul":
      return answer.noul;
    case "choice":
      return answer.confidence;
    case "score":
      return answer.score;
  }
}

export function answerCell(answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return answer.noul.toFixed(2);
    case "choice":
      return `${answer.choice} (${answer.confidence.toFixed(2)})`;
    case "score":
      return `${answer.score.toFixed(2)} (${answer.confidence.toFixed(2)})`;
  }
}

function summarize(id: string, answers: readonly Answer[]): string {
  const first = answers[0];
  if (first === undefined) return `${id}: no answers`;
  if (first.type === "noul") {
    const values = answers.map((answer) => (answer as { noul: number }).noul);
    const meanValue = values.reduce((sum, value) => sum + value, 0) / values.length;
    const yes = values.filter((value) => value >= 0.5).length;
    return `${id} (noul): mean ${num(meanValue, 2)}, ≥0.5 on ${yes}/${values.length}`;
  }
  if (first.type === "choice") {
    const counts = new Map<string, number>();
    for (const answer of answers) {
      const choice = (answer as { choice: string }).choice;
      counts.set(choice, (counts.get(choice) ?? 0) + 1);
    }
    const breakdown = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([option, count]) => `${option} ${count}`)
      .join(", ");
    return `${id} (choice): ${breakdown}`;
  }
  const values = answers.map((answer) => (answer as { score: number }).score);
  const meanValue = values.reduce((sum, value) => sum + value, 0) / values.length;
  return `${id} (score): mean ${num(meanValue, 2)}, min ${num(Math.min(...values), 2)}, max ${num(
    Math.max(...values),
    2,
  )}`;
}

function applyFilter(rows: Row[], filter: MapFilter): Row[] {
  return rows.filter((row) => {
    const answer = row.answers[filter.question];
    if (answer === undefined) return false;
    if (filter.equals !== undefined) {
      return answer.type === "choice" && answer.choice === filter.equals;
    }
    const value = answerValue(answer);
    if (filter.min !== undefined && value < filter.min) return false;
    if (filter.max !== undefined && value > filter.max) return false;
    return true;
  });
}

export async function runMap(client: TypeSafeClient, args: MapArgs): Promise<string> {
  const questionIds = Object.keys(args.questions);
  const startedAt = Date.now();
  const failures: Failure[] = [];
  let inputTokens = 0;

  const settled = await mapConcurrent(
    args.items,
    args.concurrency ?? 8,
    async (item): Promise<Row | null> => {
      try {
        const response = await client.systemOne(item.state, args.questions, args.model);
        inputTokens += response.usage.input_tokens;
        return { id: item.id, state: item.state, answers: response.answers };
      } catch (error) {
        failures.push({ id: item.id, error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    },
  );

  const elapsedMs = Date.now() - startedAt;
  let rows = settled.filter((row): row is Row => row !== null);
  const evaluated = rows.length;

  if (args.filter !== undefined) rows = applyFilter(rows, args.filter);

  const sortBy = args.sort_by;
  if (sortBy !== undefined) {
    const direction = args.order === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const left = a.answers[sortBy];
      const right = b.answers[sortBy];
      if (left === undefined || right === undefined) return 0;
      return (answerValue(left) - answerValue(right)) * direction;
    });
  }

  const sections: string[] = [];

  sections.push(
    questionIds
      .map((id) =>
        summarize(
          id,
          settled
            .filter((row): row is Row => row !== null)
            .map((row) => row.answers[id])
            .filter((answer): answer is Answer => answer !== undefined),
        ),
      )
      .join("\n"),
  );

  if (args.include_rows !== false) {
    const maxRows = args.max_rows ?? 50;
    const shown = rows.slice(0, maxRows);
    sections.push(
      markdownTable(
        ["id", ...questionIds],
        shown.map((row) => [
          row.id,
          ...questionIds.map((id) => {
            const answer = row.answers[id];
            return answer === undefined ? "—" : answerCell(answer);
          }),
        ]),
      ),
    );
    if (rows.length > shown.length) {
      sections.push(
        `${rows.length - shown.length} more rows not shown — raise max_rows, narrow with ` +
          `filter, or pass save_path to write the full results to disk.`,
      );
    }
  }

  if (failures.length > 0) {
    sections.push(
      `${failures.length} item(s) failed:\n` +
        failures
          .slice(0, 5)
          .map((failure) => `- ${failure.id}: ${preview(failure.error, 160)}`)
          .join("\n"),
    );
  }

  if (args.save_path !== undefined) {
    await writeFile(
      args.save_path,
      JSON.stringify(
        {
          model: args.model ?? client.model,
          questions: args.questions,
          rows: rows.map((row) => ({ id: row.id, answers: row.answers })),
          failures,
        },
        null,
        2,
      ),
      "utf8",
    );
    sections.push(`Full results written to ${args.save_path}`);
  }

  sections.push(
    `${evaluated}/${args.items.length} items evaluated` +
      (args.filter === undefined ? "" : `, ${rows.length} matched the filter`) +
      ` · ${elapsedMs} ms · ${inputTokens} input tokens`,
  );

  return sections.join("\n\n");
}
