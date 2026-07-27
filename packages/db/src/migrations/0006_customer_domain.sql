-- The customer's registered domain.
--
-- Onboarding registers a domain, waits for DNS, verifies SSL and then tells the
-- customer their site is live — but there was nowhere to record which domain
-- that was, so every step after registration had nothing to check against and
-- the transfer-out path had nothing to hand over. It belongs on the customer,
-- not the build: a customer keeps their domain across rebuilds, and it must
-- outlive cancellation (we never hold a domain hostage).

ALTER TABLE customers ADD COLUMN IF NOT EXISTS domain TEXT;

-- One customer per domain. A second customer pointing at a live domain is a
-- mis-registration we want to fail loudly rather than discover after cutover.
CREATE UNIQUE INDEX IF NOT EXISTS customers_domain
  ON customers (domain)
  WHERE domain IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON customers TO adw_app;
