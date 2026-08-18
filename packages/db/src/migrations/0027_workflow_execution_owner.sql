-- Which engine is entitled to drive an execution.
--
-- ⛔ `replay()` drives any execution whose TYPE this engine has registered. That
-- is all the guard there was, and type names are global: two engines against the
-- same database — different activity implementations, different configuration —
-- will each happily pick up the other's work, resume from the other's journal,
-- and consume results the other engine's activities produced.
--
-- It is not hypothetical. It is what happens in this repo's own test run: one
-- engine journals `{ packId: "pack-deep-1" }` from a stub, another engine
-- replays the same execution with the production activity registry, and the
-- real activity receives "pack-deep-1" where it expects a uuid. The visible
-- symptom is a cast error. The invisible one is an execution that advances
-- using the wrong implementations and completes looking perfectly normal.
--
-- In production this was masked by leader election — a deployment convention,
-- not a property of the engine, and one that does not hold the moment a second
-- service embeds an Engine for its own workflow types.
--
-- NULL means "any engine may drive this", which is the existing behaviour and
-- stays the default. An engine constructed with an owner stamps it here, and
-- refuses executions stamped by a different one.
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS owner text;

CREATE INDEX IF NOT EXISTS workflow_executions_owner ON workflow_executions (owner) WHERE owner IS NOT NULL;
