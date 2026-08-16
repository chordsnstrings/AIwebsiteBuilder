// @adw/journeys — customer clocks (MF4, 73 units) and multi-touch journeys
// (MF5, 54 units).
//
// What existed before: one `ctx.sleep` in the whole repository — a 180-day lead
// cooldown belonging to ADW's own outreach — and a sequencing engine that ran
// cold email for the seller. Not one date was bound to a customer-facing event,
// and not one business we serve had a follow-up sequence. The durable-timer
// machinery was real; nothing pointed it at a customer.
//
// ⛔ Rows with due times, not sleeping workflows. A dental recall is six months
// out and a tenancy renewal eleven; parking 50,000 executions on multi-month
// sleeps makes every engine upgrade a migration of live sleeping state. A
// due-date table is queryable, correctable by a human, and survives a redeploy
// without ceremony.

export {
  clearJourneyCache,
  clockFor,
  clocksFor,
  clockVersion,
  allJourneys,
  journeyFor,
  journeysFor,
  journeyVersion,
  type Clock,
  type Journey,
  type JourneyStep,
} from "./catalogue.ts";

export {
  cancelReminder,
  dueReminders,
  runReminders,
  scheduleReminder,
  upcomingReminders,
  type ReminderDeliverFn,
  type ReminderDue,
  type ReminderRunResult,
  type ScheduleReminderInput,
  type ScheduleResult,
  type UpcomingReminder,
} from "./reminders.ts";

export {
  activeRuns,
  journeyEvent,
  runJourneys,
  startJourney,
  stopJourney,
  type JourneyDeliverFn,
  type JourneyRunResult,
  type JourneyRunSummary,
  type JourneyStepDue,
  type StartJourneyInput,
  type StartResult,
} from "./runs.ts";
