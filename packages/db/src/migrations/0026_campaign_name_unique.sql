-- A campaign's name is an address, so it has to be unique.
--
-- ⛔ Sourcing resolves ONE standing campaign per region by name
-- (`standing:R2:web_presence`) and enrols every lead into it. Two invariants
-- depend on there being exactly one:
--
--   * `leads` is unique on (contact_id, campaign_id), which is what stops the
--     same person being enrolled twice;
--   * the gate's frequency cap counts touches within a campaign, which is what
--     enforces 4-in-30-days.
--
-- A duplicate standing campaign silently voids both: the same contact gets a
-- second lead under the second campaign id, and their touch count restarts at
-- zero. Two sourcing runs racing on the resolve-or-create would have produced
-- exactly that, and nothing downstream would have reported anything wrong —
-- the caps would simply stop binding.
--
-- ⛔ Deduplicated first, keeping the OLDEST row of each name so existing leads
-- keep pointing at a campaign that still exists. Ad-hoc test campaigns have
-- random names and are unaffected.
WITH ranked AS (
  SELECT id, name, row_number() OVER (PARTITION BY name ORDER BY created_at, id) AS rn
    FROM campaigns
),
dupes AS (SELECT id, name FROM ranked WHERE rn > 1),
keepers AS (SELECT id, name FROM ranked WHERE rn = 1)
UPDATE leads l
   SET campaign_id = k.id
  FROM dupes d
  JOIN keepers k ON k.name = d.name
 WHERE l.campaign_id = d.id
   -- Only where the move cannot collide with a lead that already exists on the
   -- keeper; the rest are left alone and their campaign row is kept.
   AND NOT EXISTS (
     SELECT 1 FROM leads x WHERE x.contact_id = l.contact_id AND x.campaign_id = k.id
   );

DELETE FROM campaigns c
 WHERE EXISTS (
   SELECT 1 FROM campaigns o
    WHERE o.name = c.name
      AND (o.created_at, o.id) < (c.created_at, c.id)
 )
 AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.campaign_id = c.id);

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_name_unique ON campaigns (name);
