// MF14 — the protocol runtime.
//
// This family is 141 units, 34 of them safety-critical, and the coverage audit
// found nothing. The catalogue's own note is "escalation IS the product".
//
// The assertions worth having are not "does it detect a gas smell". They are:
// does a protocol STOP the agent doing what it would otherwise have done; does
// the clock keep running when nobody is looking; and is the record still there,
// unaltered, when someone comes to read it back.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import {
  acknowledgeIncident,
  clearProtocolCache,
  detectProtocol,
  exhaustedIncidents,
  forbids,
  interlockText,
  loadProtocols,
  openIncident,
  openIncidents,
  protocolById,
  protocolsFor,
  raiseManually,
  resolveIncident,
  runEscalations,
  type Notification,
} from "./src/index.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  clearProtocolCache();
});
afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
describe("the catalogue", () => {
  it("loads all 141 units from the master catalogue", () => {
    const { protocols } = loadProtocols();
    expect(protocols.length).toBe(141);
    expect(protocols.filter((p) => p.safetyCritical).length).toBe(34);
  });

  it("⛔ every interlock a protocol names actually exists", () => {
    // The loader throws otherwise. This asserts the shipped file is clean, so a
    // typo cannot silently disable a safety constraint in production.
    const { protocols, interlocks } = loadProtocols();
    for (const p of protocols) {
      for (const name of p.interlocks) {
        expect(Object.keys(interlocks), `${p.id} → ${name}`).toContain(name);
        expect(interlockText(name).length).toBeGreaterThan(10);
      }
    }
  });

  it("⛔ every safety-critical protocol is severity 1 and pages immediately", () => {
    // A safety-critical protocol on a four-hour clock is a safety-critical
    // protocol that pages after the incident is over.
    for (const p of loadProtocols().protocols.filter((x) => x.safetyCritical)) {
      expect(p.severity, p.id).toBe(1);
      expect(p.escalation[0]?.afterMinutes, p.id).toBe(0);
      // And it must escalate PAST the first contact — a chain of one is a
      // single point of failure wearing a chain's clothes.
      expect(p.escalation.length, p.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("⛔ every safety-critical protocol forbids advising and triaging", () => {
    // The catalogue says it repeatedly — "agent never triages severity itself",
    // "no agent conclusions", "no agent judgement". It is the same rule and it
    // is asserted rather than reviewed.
    for (const p of loadProtocols().protocols.filter((x) => x.safetyCritical)) {
      expect(p.interlocks, p.id).toContain("no_triage");
      expect(p.interlocks, p.id).toContain("no_advice");
      expect(p.interlocks, p.id).toContain("no_booking");
    }
  });

  it("is honest about what it cannot detect", () => {
    // 121 of 141 start with a phone call, a sensor or a letter. Claiming to
    // watch for those from a chat box would be worse than admitting it.
    const { protocols } = loadProtocols();
    const auto = protocols.filter((p) => p.detection === "automatic");
    expect(auto.length).toBeGreaterThan(15);
    for (const p of protocols) {
      if (p.detection === "automatic") expect(p.triggers.length, p.id).toBeGreaterThan(0);
      else expect(p.triggers.length, p.id).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe("detection", () => {
  const trade = { vertical: "plumber" };
  const clinic = { vertical: "clinical" };

  it("catches a gas smell in the ways people actually write it", () => {
    for (const t of [
      "I can smell gas in the kitchen",
      "there's a gas smell coming from the boiler",
      "my CO alarm is going off",
      "think we have a carbon monoxide problem",
    ]) {
      const m = detectProtocol(t, trade);
      expect(m?.protocol.id, t).toBe("gas_smell_co_reported_mid_chat");
      expect(m?.protocol.severity).toBe(1);
    }
  });

  it("⛔ takes the MORE serious protocol when a message trips several", () => {
    // "I fell on your steps and my phone has gone missing" is both an injury
    // and an alleged theft. Which one wins must not depend on file order.
    const m = detectProtocol("I fell on your steps and my phone has gone missing", { vertical: "cleaning" });
    expect(m).not.toBeNull();
    expect(m!.protocol.severity).toBe(1);
  });

  it("scopes OPERATIONAL protocols to the vertical they belong to", () => {
    const plumber = protocolsFor("plumber").map((p) => p.id);
    const childcare = protocolsFor("childcare").map((p) => p.id);
    expect(plumber).toContain("gas_smell_co_reported_mid_chat");
    expect(childcare).not.toContain("gas_smell_co_reported_mid_chat");
    expect(childcare).toContain("child_uncollected_at_closing");
    expect(plumber).not.toContain("child_uncollected_at_closing");
  });

  it("⛔ but a disclosure of HARM reaches every vertical", () => {
    // Generated from the catalogue this was wrong: safeguarding sat under
    // clinical and education only, so a NURSERY had no safeguarding protocol
    // at all. A child discloses to whoever is in front of them — a
    // hairdresser, a driving instructor, a plumber working in the house — and
    // the taxonomy has no bearing on that.
    for (const vertical of ["plumber", "beauty", "childcare", "auto_repair", "lawyer", "hospitality"]) {
      const ids = protocolsFor(vertical).map((p) => p.id);
      expect(ids, `${vertical} safeguarding`).toContain("safeguarding_disclosure");
      expect(ids, `${vertical} red flag`).toContain("red_flag_symptom_in_chat");
      expect(ids, `${vertical} data breach`).toContain("suspected_data_breach");
    }
  });

  it("⛔ catches a disclosure in the words a frightened person actually uses", () => {
    // "hit me" does not match "hitting me". The first version of these patterns
    // missed every one of these, and the suite is the only reason that is known.
    for (const t of [
      "my stepdad has been hitting me",
      "he keeps hurting me",
      "im scared to go home",
      "someone is hurting my little brother",
      "I don't feel safe at home",
    ]) {
      const m = detectProtocol(t, { vertical: "beauty" });
      expect(m?.protocol.safetyCritical, t).toBe(true);
    }
  });

  it("catches clinical red flags", () => {
    for (const t of ["I've got chest pain", "he can't breathe", "she's unconscious", "I took too many pills"]) {
      expect(detectProtocol(t, clinic)?.protocol.id, t).toBe("red_flag_symptom_in_chat");
    }
  });

  it("does not fire on ordinary business questions", () => {
    for (const t of [
      "do you cover Bermondsey?",
      "how much for a boiler service?",
      "what are your opening hours?",
      "can I book for Tuesday?",
    ]) {
      expect(detectProtocol(t, trade), t).toBeNull();
    }
  });

  it("⛔ the response is fixed and never quotes the visitor back", () => {
    // A safeguarding disclosure echoed into a transcript on a shared family
    // computer is a second harm, and "just to confirm, you said..." is the most
    // natural thing in the world for a chat agent to write.
    const disclosure = "my stepdad has been hitting me";
    const m = detectProtocol(disclosure, { vertical: "childcare" });
    expect(m).not.toBeNull();
    expect(m!.respond).not.toContain("stepdad");
    expect(m!.respond).not.toContain("hitting");
    // ...and it does not name who was told.
    expect(m!.respond.toLowerCase()).not.toContain("safeguarding lead");
  });

  it("names what the agent may no longer do", () => {
    const m = detectProtocol("I can smell gas", trade)!;
    expect(forbids(m, "book")).toBe(true);
    expect(forbids(m, "advise")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the incident record", () => {
  const gas = () => detectProtocol("I can smell gas in the hallway", { vertical: "plumber" })!;

  it("stores the visitor's words verbatim and schedules the whole chain at once", async () => {
    // ⛔ Every step now, in one transaction. Scheduling step 2 only after step 1
    // fires means a worker that dies between them loses the rest of the chain
    // silently — which a safeguarding escalation cannot do.
    const opened = await openIncident(db, { match: gas(), triggerText: "I can smell gas in the hallway" });
    expect(opened.severity).toBe(1);
    expect(opened.stepsScheduled).toBe(3);
    const row = await db.one<{ trigger_text: string; interlocks: string[] }>(
      "SELECT trigger_text, interlocks FROM protocol_incidents WHERE id = $1",
      [opened.incidentId],
    );
    expect(row.trigger_text).toBe("I can smell gas in the hallway");
    expect(row.interlocks).toContain("no_booking");
    const steps = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM protocol_escalations WHERE incident_id = $1",
      [opened.incidentId],
    );
    expect(Number(steps.n)).toBe(3);
  });

  it("⛔ never puts the trigger text in the event log", async () => {
    // The event log is read casually and widely. The disclosure lives in one
    // append-only table with a reason to open it.
    const phrase = `gas smell ref-${Date.now()}`;
    await openIncident(db, { match: gas(), triggerText: phrase });
    const leaked = await db.maybeOne(
      "SELECT 1 AS x FROM events WHERE event_type LIKE 'protocol.%' AND payload::text LIKE $1",
      [`%${phrase}%`],
    );
    expect(leaked).toBeNull();
  });

  it("⛔ the evidence is immutable and an incident cannot be un-acknowledged", async () => {
    const opened = await openIncident(db, { match: gas(), triggerText: "smell gas" });
    await expect(
      db.query("UPDATE protocol_incidents SET trigger_text = 'nothing happened' WHERE id = $1", [opened.incidentId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query("DELETE FROM protocol_incidents WHERE id = $1", [opened.incidentId]),
    ).rejects.toThrow(/append-only/);

    await acknowledgeIncident(db, opened.incidentId, "lead@example.com");
    await expect(
      db.query("UPDATE protocol_incidents SET acknowledged_at = NULL WHERE id = $1", [opened.incidentId]),
    ).rejects.toThrow(/un-acknowledged/);
  });

  it("can be raised by hand, which is the only way 121 of them start", async () => {
    const opened = await raiseManually(db, "legal_letter_received", {
      triggerText: "Letter before action received by post",
      raisedBy: "owner@example.com",
    });
    const row = await db.one<{ detected_by: string; raised_by: string }>(
      "SELECT detected_by, raised_by FROM protocol_incidents WHERE id = $1",
      [opened.incidentId],
    );
    expect(row.detected_by).toBe("manual");
    expect(row.raised_by).toBe("owner@example.com");
  });

  it("refuses to raise a protocol that is not in the catalogue", async () => {
    await expect(
      raiseManually(db, "invented_protocol", { triggerText: "x", raisedBy: "o@example.com" }),
    ).rejects.toThrow(/Unknown protocol/);
  });
});

// ---------------------------------------------------------------------------
describe("the clock", () => {
  const gas = () => detectProtocol("I can smell gas", { vertical: "plumber" })!;
  const at = (min: number) => new Date(Date.UTC(2026, 7, 20, 10, 0) + min * 60_000);

  it("fires steps as they come due, and only those", async () => {
    const opened = await openIncident(db, { match: gas(), triggerText: "smell gas" }, at(0));
    const seen: Notification[] = [];
    const notify = async (n: Notification) => {
      if (n.incidentId === opened.incidentId) seen.push(n);
      return { delivered: true };
    };

    await runEscalations(db, notify, at(0));
    expect(seen.map((s) => s.notifyRole)).toEqual(["designated_lead"]);

    await runEscalations(db, notify, at(5));
    expect(seen.length, "nothing else is due at +5").toBe(1);

    await runEscalations(db, notify, at(20));
    expect(seen.map((s) => s.notifyRole)).toEqual(["designated_lead", "owner"]);

    await runEscalations(db, notify, at(90));
    expect(seen.map((s) => s.notifyRole)).toEqual(["designated_lead", "owner", "operator"]);
  });

  it("⛔ the page never carries the disclosure", async () => {
    // A page lands on a lock screen. It says "there is an incident, open it".
    const opened = await openIncident(db, { match: gas(), triggerText: "my child told me something" }, at(0));
    let payload: Notification | null = null;
    await runEscalations(db, async (n) => {
      if (n.incidentId === opened.incidentId) payload = n;
      return { delivered: true };
    }, at(0));
    expect(payload).not.toBeNull();
    expect(JSON.stringify(payload)).not.toContain("my child told me");
  });

  it("⛔ acknowledgement stops the remaining chain and nothing else", async () => {
    // "Someone saw it" and "someone dealt with it" are different facts. A board
    // that conflates them shows green over open safeguarding cases.
    const opened = await openIncident(db, { match: gas(), triggerText: "smell gas" }, at(0));
    const ack = await acknowledgeIncident(db, opened.incidentId, "lead@example.com", at(1));
    expect(ack.stepsCancelled).toBe(3);

    let fired = 0;
    await runEscalations(db, async (n) => {
      if (n.incidentId === opened.incidentId) fired++;
      return { delivered: true };
    }, at(600));
    expect(fired).toBe(0);

    // Still open, because acknowledged is not resolved.
    const open = await openIncidents(db);
    expect(open.map((i) => i.id)).toContain(opened.incidentId);
    await resolveIncident(db, opened.incidentId, "lead@example.com", "Engineer attended, leak isolated");
    const after = await openIncidents(db);
    expect(after.map((i) => i.id)).not.toContain(opened.incidentId);
  });

  it("moves past a contact who does not answer rather than stalling", async () => {
    // A chain that retries an unreachable person forever is not a chain.
    const opened = await openIncident(db, { match: gas(), triggerText: "smell gas" }, at(0));
    const roles: string[] = [];
    const notify = async (n: Notification) => {
      if (n.incidentId !== opened.incidentId) return { delivered: true };
      roles.push(n.notifyRole);
      throw new Error("phone off");
    };
    await runEscalations(db, notify, at(0));
    await runEscalations(db, notify, at(20));
    await runEscalations(db, notify, at(90));
    expect(roles).toEqual(["designated_lead", "owner", "operator"]);
  });

  it("⛔ surfaces an incident whose whole chain fired with nobody answering", async () => {
    // This is the state the family exists to make impossible, so it is asked
    // for explicitly rather than inferred from an empty due-list. Absent from
    // the queue and screaming on the console are different things.
    const opened = await openIncident(db, { match: gas(), triggerText: "smell gas" }, at(0));
    await runEscalations(db, async () => ({ delivered: true }), at(1000));
    const dead = await exhaustedIncidents(db);
    expect(dead.map((d) => d.id)).toContain(opened.incidentId);
  });
});

// ---------------------------------------------------------------------------
describe("the queue a human works", () => {
  it("puts the most serious first, then the oldest", async () => {
    const rows = await openIncidents(db);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      expect(prev.severity).toBeLessThanOrEqual(cur.severity);
      if (prev.severity === cur.severity) {
        expect(new Date(prev.createdAt).getTime()).toBeLessThanOrEqual(new Date(cur.createdAt).getTime());
      }
    }
  });

  it("tells the human what the agent is forbidden from doing, and what stays theirs", async () => {
    const rows = await openIncidents(db);
    const gas = rows.find((r) => r.protocolId === "gas_smell_co_reported_mid_chat");
    expect(gas?.interlocks).toContain("no_booking");
    const safeguarding = protocolById("safeguarding_disclosure");
    expect(safeguarding?.staysHuman).toBeTruthy();
  });
});
