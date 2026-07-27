export {
  complete,
  GatewayError,
  type GatewayDeps,
  type GatewayRequest,
  type GatewayResult,
} from "./gateway.ts";
export { dataClassEligible } from "./dataclass.ts";
export { BudgetExceededError, roleSpendTodayUsd, totalSpendTodayUsd, checkDailyTotal } from "./budget.ts";
export type { DataClass, RoleId, ModelRef } from "@adw/registry";
