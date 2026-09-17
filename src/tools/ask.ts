/** `jev_ask`: run a question set once against one state, to prototype wording. */

import type { Answer, JsonValue, Question, TypeSafeClient } from "../typesafe.ts";

const topOptions = (probabilities: Record<string, number>, limit = 4): string =>
  Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([option, probability]) => `${option} ${probability.toFixed(2)}`)
    .join(", ");

export function describeAnswer(id: string, answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return `${id} (noul): ${answer.noul.toFixed(3)}`;
    case "choice":
      return (
        `${id} (choice): ${answer.choice} — confidence ${answer.confidence.toFixed(2)} ` +
        `[${topOptions(answer.probabilities)}]`
      );
    case "score": {
      const nearest = answer.legend[String(Math.round(answer.score))] ?? "";
      const levels = Object.keys(answer.legend).length - 1;
      return (
        `${id} (score): ${answer.score.toFixed(2)}/${levels} ≈ "${nearest}" — ` +
        `confidence ${answer.confidence.toFixed(2)} [${topOptions(answer.probabilities)}]`
      );
    }
  }
}

export async function runAsk(
  client: TypeSafeClient,
  args: { state: JsonValue; questions: Record<string, Question>; model?: string },
): Promise<string> {
  const startedAt = Date.now();
  const response = await client.systemOne(args.state, args.questions, args.model);
  const elapsedMs = Date.now() - startedAt;

  const lines = Object.entries(response.answers).map(([id, answer]) =>
    describeAnswer(id, answer),
  );
  return [
    ...lines,
    "",
    `${response.model} · ${elapsedMs} ms · ${response.usage.input_tokens} input tokens`,
    "Confidence and probabilities are only meaningful once measured: run jev_eval on labeled " +
      "examples before hard-coding a threshold.",
  ].join("\n");
}
