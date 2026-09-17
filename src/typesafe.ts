/** Minimal client for TypeSafe's System One endpoint (POST /v1/systemone). */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
}

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";

export class TypeSafeApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`TypeSafe API returned ${status}: ${body.slice(0, 500)}`);
    this.name = "TypeSafeApiError";
    this.status = status;
    this.body = body;
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 20_000);
  return Math.min(250 * 2 ** attempt, 8_000) + Math.random() * 250;
}

export class TypeSafeClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async systemOne(
    state: JsonValue,
    questions: Record<string, Question>,
    model?: string,
  ): Promise<SystemOneResponse> {
    const payload = JSON.stringify({
      state,
      model: model ?? this.model,
      questions,
    });

    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.ok) return (await response.json()) as SystemOneResponse;

        const body = await response.text();
        const error = new TypeSafeApiError(response.status, body);
        if (!RETRYABLE_STATUS.has(response.status)) throw error;
        lastError = error;
        if (attempt < this.maxAttempts - 1) {
          await sleep(retryDelayMs(attempt, response.headers.get("retry-after")));
        }
      } catch (error) {
        if (error instanceof TypeSafeApiError && !RETRYABLE_STATUS.has(error.status)) throw error;
        lastError = error;
        if (attempt < this.maxAttempts - 1) await sleep(retryDelayMs(attempt, null));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** Runs `task` over `items` with at most `concurrency` in flight, preserving order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const item = items[index];
        if (index >= items.length || item === undefined) return;
        results[index] = await task(item, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
