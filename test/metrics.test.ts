import assert from "node:assert/strict";
import { test } from "node:test";

import {
  choiceMetrics,
  expectedCalibrationError,
  noulMetrics,
  rocAuc,
  scoreMetrics,
} from "../src/metrics.ts";

test("rocAuc separates perfectly ranked predictions", () => {
  assert.equal(rocAuc([0.1, 0.2, 0.8, 0.9], [false, false, true, true]), 1);
  assert.equal(rocAuc([0.9, 0.8, 0.2, 0.1], [false, false, true, true]), 0);
  assert.equal(rocAuc([0.5, 0.5], [true, false]), 0.5);
  assert.equal(rocAuc([0.1, 0.9], [true, true]), null);
});

test("expectedCalibrationError is zero for perfectly calibrated bins", () => {
  const probabilities = [0.05, 0.05, 0.95, 0.95];
  const outcomes = [false, false, true, true];
  assert.ok(expectedCalibrationError(probabilities, outcomes) < 0.06);

  const overconfident = expectedCalibrationError([0.99, 0.99], [true, false]);
  assert.ok(overconfident > 0.4);
});

test("noulMetrics finds the threshold that separates the classes", () => {
  const metrics = noulMetrics(
    [0.05, 0.1, 0.62, 0.7, 0.9],
    [false, false, true, true, true],
  );
  assert.equal(metrics.n, 5);
  assert.equal(metrics.positives, 3);
  assert.equal(metrics.bestF1.f1, 1);
  assert.ok(metrics.bestF1.threshold > 0.1 && metrics.bestF1.threshold <= 0.62);
  assert.equal(metrics.auc, 1);

  const strict = metrics.sweep.find((row) => row.threshold === 0.95);
  assert.deepEqual(
    { tp: strict?.tp, fp: strict?.fp, fn: strict?.fn, tn: strict?.tn },
    { tp: 0, fp: 0, fn: 3, tn: 2 },
  );
});

test("choiceMetrics reports per-class scores and an abstention curve", () => {
  const predictions = [
    { choice: "billing", probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.9 },
    { choice: "billing", probabilities: { billing: 0.6, technical: 0.4 }, confidence: 0.55 },
    { choice: "technical", probabilities: { billing: 0.2, technical: 0.8 }, confidence: 0.8 },
  ];
  const metrics = choiceMetrics(predictions, ["billing", "technical", "technical"], [
    "billing",
    "technical",
  ]);

  assert.equal(metrics.n, 3);
  assert.ok(Math.abs(metrics.accuracy - 2 / 3) < 1e-9);
  assert.equal(metrics.perClass["billing"]?.precision, 0.5);
  assert.equal(metrics.perClass["technical"]?.recall, 0.5);
  assert.equal(metrics.confusion["technical"]?.["billing"], 1);

  const highBar = metrics.coverage.find((row) => row.minConfidence === 0.8);
  assert.equal(highBar?.accuracyOnCovered, 1);
  assert.ok((highBar?.coverage ?? 0) < 1);
});

test("scoreMetrics measures distance from the labeled level", () => {
  const metrics = scoreMetrics(
    [
      { score: 1.6, confidence: 0.8 },
      { score: 0.2, confidence: 0.4 },
    ],
    [2, 0],
  );
  assert.equal(metrics.n, 2);
  assert.ok(Math.abs(metrics.mae - 0.3) < 1e-9);
  assert.equal(metrics.exactAccuracy, 1);
  assert.equal(metrics.withinOne, 1);
  assert.equal(metrics.coverage.find((row) => row.minConfidence === 0.7)?.coverage, 0.5);
});
