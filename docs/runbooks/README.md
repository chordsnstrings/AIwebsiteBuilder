# ADW Runbooks (R1–R20)

Each runbook is an addressable identifier (`RunbookId`) referenced by the
Sentinel's diagnosis output and tested in DR rehearsal (spec §47, §56, §75.7).
Each has automatic actions the system takes *before* an operator reads, an
operator decision point, and a rollback (or an explicit "none — one-way").

| Id | Trigger | Automatic action | Severity |
|---|---|---|---|
| **R1** | Mailbox provider mass suspension (retirements ≥3× baseline / 24h) | Pool halted, sending redistributed at existing caps | SEV2 |
| **R2** | Complaint rate breach (any domain > 0.20%) | Domain halted + removed from rotation; template paused | SEV2 |
| **R3** | Processor termination / warning (notice, or dispute rate > 0.5%) | `HALT_PAYMENTS_ONBOARDING`; dispute evidence packs drafted | **SEV1** |
| **R4** | Gate outage (> 5 min) | Fail closed — nothing sends | **SEV1** |
| **R5** | Canary hit (any) | `HALT_AGENT:<role>`; 24h outbound quarantine; canary rotated | **SEV1** |
| **R6** | Malicious content in generated sites (duplicate-content cap or anomaly) | `HALT_BUILDS`; fleet-wide signature scan; roll back | **SEV1** |
| **R7** | Model provider outage (all candidates failing for a role) | Gateway failover; if all fail, halt builds (never ship ungated) | SEV2 |
| **R8** | Regulator contact | Escalate to human; halt affected channel | **SEV1** |
| **R9** | Press inquiry | Escalate to human; no substantive comment | SEV2 |
| **R10** | Customer site outage (availability < 99.5% over 15 min) | Static export to secondary origin + DNS failover | SEV2 |
| **R11** | DSAR received | Operator-invokable export job (signed ZIP + manifest) | SEV3 |
| **R12** | Payments silent failure | Account marked not-live; "you're live" suppressed; if any `charge_type != direct`, halt payments and audit | **SEV1** |
| **R13** | Enable a new market | 12-step market onboarding (counsel → config → pilot → gate → scale) | — |
| **R14** | Change a champion outside cadence | Requires a stored eval run; audit row written | — |
| **R15** | Key-person unavailability | Runbooks + break-glass credentials in escrow | SEV2 |
| **R16** | Sentinel heartbeat lost (dead man's switch fires) | External service alerts the human directly | **SEV1** |
| **R17** | Multi-vendor event (> 10 vendors failing) | Single `multi_vendor_event`; suspect own network/DNS first | SEV2 |
| **R18** | Vendor credential expiry imminent (3 days, unrotated) | Escalation to human; Orchestrator cannot mint a replacement | SEV2 |
| **R19** | Vendor balance exhausted / contract lapsed (< 7 days' burn) | Exception raised; provisioning paused for that vendor | SEV2 |
| **R20** | Vendor subprocessor / terms change (training/retention/residency) | Exception + DPA re-review; registry re-selection if a model | SEV3 |

## Load-bearing rules restated

- **R2:** do NOT resume the domain — retire it. Rollback: none (one-way). If
  > 2 domains breach in 7 days, halt cold sending entirely (treat as SEV2).
- **R3:** NEVER open a second processor account under a different entity — this
  is fraud and ends the company.
- **R6:** time-to-contain target < 2h from detection to all sites rolled back;
  a **human** writes the customer notification (never an agent).
- **R16:** you are alerted by *absence*, not presence — the heartbeat vendor
  monitors nothing else in the stack.
