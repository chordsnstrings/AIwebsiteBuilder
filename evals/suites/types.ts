// Shared result shapes for the evals/ suites. A suite always reports the number
// of cases it attempted, the number whose defence actually held, and a human
// readable line per failure. A suite that cannot run a case reports it as a
// failure — never as a silent skip.

export interface SuiteResult {
  total: number;
  passed: number;
  failures: string[];
}

export interface NamedSuiteResult extends SuiteResult {
  /** Suite identifier, written to eval_runs.suite. */
  suite: string;
  /** The registry role this suite exercises, written to eval_runs.role. */
  role: string;
  /** Extra numbers a suite wants recorded on the eval run (e.g. recall). */
  detail?: Record<string, number | string | boolean>;
}

export function passRate(r: SuiteResult): number {
  return r.total === 0 ? 0 : r.passed / r.total;
}
