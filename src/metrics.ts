/** Scoring helpers for `jev_eval`: accuracy, calibration, and threshold sweeps. */

export interface SweepRow {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
}

export interface NoulMetrics {
  n: number;
  positives: number;
  brier: number;
  ece: number;
  auc: number | null;
  sweep: SweepRow[];
  bestF1: SweepRow;
  bestAccuracy: SweepRow;
}

export interface CoverageRow {
  minConfidence: number;
  coverage: number;
  accuracyOnCovered: number | null;
}

export interface ClassMetrics {
  support: number;
  predicted: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ChoiceMetrics {
  n: number;
  accuracy: number;
  macroF1: number;
  brier: number;
  ece: number;
  perClass: Record<string, ClassMetrics>;
  confusion: Record<string, Record<string, number>>;
  coverage: CoverageRow[];
}

export interface ScoreCoverageRow {
  minConfidence: number;
  coverage: number;
  maeOnCovered: number | null;
}

export interface ScoreMetrics {
  n: number;
  mae: number;
  rmse: number;
  exactAccuracy: number;
  withinOne: number;
  coverage: ScoreCoverageRow[];
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const safeDiv = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

/**
 * Expected calibration error over equal-width bins: the average gap between a
 * bin's mean predicted probability and the rate at which it was right.
 */
export function expectedCalibrationError(
  probabilities: readonly number[],
  outcomes: readonly boolean[],
  bins = 10,
): number {
  if (probabilities.length === 0) return 0;
  let error = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const lower = bin / bins;
    const upper = (bin + 1) / bins;
    const indices: number[] = [];
    for (let i = 0; i < probabilities.length; i += 1) {
      const p = probabilities[i] ?? 0;
      if (p > lower && p <= upper) indices.push(i);
      else if (bin === 0 && p <= lower) indices.push(i);
    }
    if (indices.length === 0) continue;
    const binProbability = mean(indices.map((i) => probabilities[i] ?? 0));
    const binAccuracy = mean(indices.map((i) => (outcomes[i] === true ? 1 : 0)));
    error += (indices.length / probabilities.length) * Math.abs(binProbability - binAccuracy);
  }
  return error;
}

/** Area under the ROC curve, computed from mid-ranks so ties count as half. */
export function rocAuc(scores: readonly number[], labels: readonly boolean[]): number | null {
  const positives = labels.filter(Boolean).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return null;

  const order = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => a.score - b.score);
  const ranks = new Array<number>(scores.length).fill(0);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.score === order[i]?.score) j += 1;
    const midRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      const entry = order[k];
      if (entry !== undefined) ranks[entry.index] = midRank;
    }
    i = j + 1;
  }

  let positiveRankSum = 0;
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === true) positiveRankSum += ranks[i] ?? 0;
  }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function sweepRow(
  probabilities: readonly number[],
  labels: readonly boolean[],
  threshold: number,
): SweepRow {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < probabilities.length; i += 1) {
    const predicted = (probabilities[i] ?? 0) >= threshold;
    const actual = labels[i] === true;
    if (predicted && actual) tp += 1;
    else if (predicted) fp += 1;
    else if (actual) fn += 1;
    else tn += 1;
  }
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  return {
    threshold,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1: safeDiv(2 * precision * recall, precision + recall),
    accuracy: safeDiv(tp + tn, probabilities.length),
  };
}

export function noulMetrics(
  probabilities: readonly number[],
  labels: readonly boolean[],
): NoulMetrics {
  const candidates = new Set<number>();
  for (let step = 1; step <= 19; step += 1) candidates.add(step / 20);
  for (const p of probabilities) {
    candidates.add(Math.min(1, Math.round(p * 100) / 100));
  }
  const sweep = [...candidates]
    .sort((a, b) => a - b)
    .map((threshold) => sweepRow(probabilities, labels, threshold));

  const pickBest = (key: "f1" | "accuracy"): SweepRow =>
    sweep.reduce((best, row) => {
      if (row[key] > best[key]) return row;
      if (row[key] === best[key] && Math.abs(row.threshold - 0.5) < Math.abs(best.threshold - 0.5)) {
        return row;
      }
      return best;
    }, sweep[0] ?? sweepRow(probabilities, labels, 0.5));

  return {
    n: probabilities.length,
    positives: labels.filter(Boolean).length,
    brier: mean(probabilities.map((p, i) => (p - (labels[i] === true ? 1 : 0)) ** 2)),
    ece: expectedCalibrationError(probabilities, labels),
    auc: rocAuc(probabilities, labels),
    sweep,
    bestF1: pickBest("f1"),
    bestAccuracy: pickBest("accuracy"),
  };
}

export interface ChoicePrediction {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

const CONFIDENCE_STEPS = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

function coverageRows(
  confidences: readonly number[],
  correct: readonly boolean[],
): CoverageRow[] {
  return CONFIDENCE_STEPS.map((minConfidence) => {
    const kept = confidences
      .map((confidence, index) => ({ confidence, index }))
      .filter((entry) => entry.confidence >= minConfidence);
    return {
      minConfidence,
      coverage: safeDiv(kept.length, confidences.length),
      accuracyOnCovered:
        kept.length === 0 ? null : mean(kept.map((entry) => (correct[entry.index] ? 1 : 0))),
    };
  });
}

export function choiceMetrics(
  predictions: readonly ChoicePrediction[],
  labels: readonly string[],
  options: readonly string[],
): ChoiceMetrics {
  const classes = [...new Set([...options, ...labels, ...predictions.map((p) => p.choice)])];
  const correct = predictions.map((prediction, i) => prediction.choice === labels[i]);

  const confusion: Record<string, Record<string, number>> = {};
  for (const actual of classes) {
    confusion[actual] = Object.fromEntries(classes.map((predicted) => [predicted, 0]));
  }
  predictions.forEach((prediction, i) => {
    const actual = labels[i];
    if (actual === undefined) return;
    const row = confusion[actual];
    if (row !== undefined) row[prediction.choice] = (row[prediction.choice] ?? 0) + 1;
  });

  const perClass: Record<string, ClassMetrics> = {};
  for (const className of classes) {
    const support = labels.filter((label) => label === className).length;
    const predicted = predictions.filter((prediction) => prediction.choice === className).length;
    const truePositives = predictions.filter(
      (prediction, i) => prediction.choice === className && labels[i] === className,
    ).length;
    const precision = safeDiv(truePositives, predicted);
    const recall = safeDiv(truePositives, support);
    perClass[className] = {
      support,
      predicted,
      precision,
      recall,
      f1: safeDiv(2 * precision * recall, precision + recall),
    };
  }

  const scored = classes.filter((className) => (perClass[className]?.support ?? 0) > 0);

  // Brier over the full distribution, averaged per item (multi-class Brier score).
  const brier = mean(
    predictions.map((prediction, i) =>
      classes.reduce((sum, className) => {
        const probability = prediction.probabilities[className] ?? 0;
        return sum + (probability - (labels[i] === className ? 1 : 0)) ** 2;
      }, 0),
    ),
  );

  return {
    n: predictions.length,
    accuracy: mean(correct.map((value) => (value ? 1 : 0))),
    macroF1: mean(scored.map((className) => perClass[className]?.f1 ?? 0)),
    brier,
    ece: expectedCalibrationError(
      predictions.map((prediction) => prediction.probabilities[prediction.choice] ?? 0),
      correct,
    ),
    perClass,
    confusion,
    coverage: coverageRows(
      predictions.map((prediction) => prediction.confidence),
      correct,
    ),
  };
}

export interface ScorePrediction {
  score: number;
  confidence: number;
}

export function scoreMetrics(
  predictions: readonly ScorePrediction[],
  labels: readonly number[],
): ScoreMetrics {
  const errors = predictions.map((prediction, i) => prediction.score - (labels[i] ?? 0));
  const confidences = predictions.map((prediction) => prediction.confidence);

  return {
    n: predictions.length,
    mae: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map((error) => error ** 2))),
    exactAccuracy: mean(
      predictions.map((prediction, i) => (Math.round(prediction.score) === labels[i] ? 1 : 0)),
    ),
    withinOne: mean(errors.map((error) => (Math.abs(error) <= 1 ? 1 : 0))),
    coverage: CONFIDENCE_STEPS.map((minConfidence) => {
      const kept = confidences
        .map((confidence, index) => ({ confidence, index }))
        .filter((entry) => entry.confidence >= minConfidence);
      return {
        minConfidence,
        coverage: safeDiv(kept.length, confidences.length),
        maeOnCovered:
          kept.length === 0
            ? null
            : mean(kept.map((entry) => Math.abs(errors[entry.index] ?? 0))),
      };
    }),
  };
}
