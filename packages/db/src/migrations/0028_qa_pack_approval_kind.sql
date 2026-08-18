-- Who approved a Q&A pack, and on what authority.
--
-- §21.3 says an unapproved pack must never reach a visitor, and
-- `assertPackApproved` enforces it by checking `approved_at`. That was fine
-- while every pack belonged to a customer with an owner to sign it.
--
-- ⛔ A SPECULATIVE PREVIEW HAS NO OWNER TO SIGN. The entire point of the preview
-- is to reach a business that has not been contacted yet, so its pack can never
-- carry an owner's signature — and the acquisition pitch ("here is a
-- receptionist that already knows your business; ask it what you charge") does
-- not work without one. The resolution taken here is that §21.3 protects the
-- CUSTOMER'S SITE VISITORS: people who believe they are talking to the business.
-- The preview is emailed to the business owner, is banner-labelled as an
-- unofficial preview, answers only from what that business itself published,
-- and refuses everything else.
--
-- ⛔ THE TWO APPROVALS MUST NEVER BE CONFUSABLE. A speculative approval is a
-- policy decision made by this system; an owner approval is a person's
-- signature and is the evidence that makes a stored answer defensible. Storing
-- both as a bare timestamp would let a pack approved on policy drift into
-- serving a paying customer's live site, which is precisely the failure §21.3
-- exists to prevent. So the kind is explicit, and the last CHECK below makes the
-- dangerous combination structurally impossible rather than merely unintended.
ALTER TABLE qa_packs ADD COLUMN IF NOT EXISTS approval_kind text;

-- Everything already approved was approved by a person: this column is new, and
-- the speculative path did not exist before it.
UPDATE qa_packs SET approval_kind = 'owner' WHERE approved_at IS NOT NULL AND approval_kind IS NULL;

-- The constraints that enforce all of the above live in 0029, which corrects a
-- three-valued-logic bug in the version first written here.
