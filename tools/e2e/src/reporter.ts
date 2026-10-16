/**
 * Playwright reporter that writes `results.json`: one record per flow, sorted,
 * with the flow's own status. A flow that failed before its fixture could
 * attach a record still appears, with its status and empty lists, so a red run
 * can never produce a file that reads as green.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { CLOCK_T0_ISO, RESULTS_FILE } from "./config";
import { buildResults, stableJson, type FlowRecord } from "./record";

export const RECORD_ATTACHMENT = "e2e-record";

export function recordFor(
  test: Pick<TestCase, "title">,
  result: Pick<TestResult, "status" | "attachments">,
): FlowRecord {
  const attachment = result.attachments.find((a) => a.name === RECORD_ATTACHMENT);
  const base: FlowRecord = attachment?.body
    ? (JSON.parse(attachment.body.toString("utf8")) as FlowRecord)
    : { flow: test.title, status: result.status, steps: [], requests: [], assertions: [] };
  return { ...base, flow: test.title, status: result.status };
}

export default class ResultsReporter implements Reporter {
  private readonly records = new Map<string, FlowRecord>();

  onTestEnd(test: TestCase, result: TestResult): void {
    this.records.set(test.title, recordFor(test, result));
  }

  onEnd(): void {
    mkdirSync(dirname(RESULTS_FILE), { recursive: true });
    writeFileSync(RESULTS_FILE, stableJson(buildResults(CLOCK_T0_ISO, [...this.records.values()])));
  }

  printsToStdio(): boolean {
    return false;
  }
}
