-- Load one day of the ecosystem dataset into Unity Catalog and expose it over
-- Delta Sharing (which is both what a Databricks Marketplace listing serves and
-- what a self-hosted share serves - the same objects either way).
--
-- Prerequisites: Premium plan or above, a Unity Catalog-enabled workspace, and
-- a role with CREATE CATALOG. Run in a SQL warehouse or a notebook.
-- `node scripts/dataset-export.mjs --day <day> --out ./export` has written the
-- NDJSON locally; upload that directory to a UC volume first (Catalog Explorer,
-- or `databricks fs cp -r ./export dbfs:/Volumes/agent402/ecosystem/landing/`).

CREATE CATALOG IF NOT EXISTS agent402;
CREATE SCHEMA  IF NOT EXISTS agent402.ecosystem;
CREATE VOLUME  IF NOT EXISTS agent402.ecosystem.landing;

-- ---------------------------------------------------------------------------
-- Ingest. Delta tables partitioned by day, appended per snapshot, so the same
-- statement re-runs for each new day without rewriting history. Replace the
-- date throughout.

CREATE TABLE IF NOT EXISTS agent402.ecosystem.sellers (
  dt DATE, origin STRING, display_name STRING, homepage STRING,
  primary_network STRING, networks ARRAY<STRING>, tool_count BIGINT,
  paid_tool_count BIGINT, origin_responded BOOLEAN, discovery_path STRING,
  source STRING, health DOUBLE, routable BOOLEAN, mpp BOOLEAN,
  stellar_pay_to STRING, algorand_pay_to STRING,
  pay_to_by_network MAP<STRING,STRING>, payment_networks_known BOOLEAN,
  router_dispatch_eligible BOOLEAN, router_dispatch_reason STRING,
  fetched_at TIMESTAMP, crawl_error STRING
) USING DELTA PARTITIONED BY (dt);

-- The provenance columns are the product: price_source, origin_declared_price,
-- quote_observed_at and quote_carried_forward are what a public price lookup
-- cannot give you, and what makes a daily series worth subscribing to.
CREATE TABLE IF NOT EXISTS agent402.ecosystem.routes (
  dt DATE, origin STRING, route STRING, method STRING, price_usd DOUBLE,
  price_source STRING, price_resolved_from STRING, origin_declared_price DOUBLE,
  quote_observed_at TIMESTAMP, quote_carried_forward BOOLEAN,
  networks ARRAY<STRING>, networks_inferred BOOLEAN,
  networks_verified_at TIMESTAMP, method_inferred BOOLEAN,
  method_corrected_from STRING, url_template STRING
) USING DELTA PARTITIONED BY (dt);

CREATE TABLE IF NOT EXISTS agent402.ecosystem.settlement_base (
  dt DATE, name STRING, origins ARRAY<STRING>, homepage STRING, pay_to STRING,
  pay_to_count BIGINT, network STRING, calls_settled BIGINT, total_usd DOUBLE,
  unique_buyers BIGINT,          -- a COUNT; buyer addresses are never published
  endpoints BIGINT
) USING DELTA PARTITIONED BY (dt);

CREATE TABLE IF NOT EXISTS agent402.ecosystem.settlement_solana (
  dt DATE, pay_to STRING, origins ARRAY<STRING>, credits BIGINT, payers BIGINT,
  truncated BOOLEAN, stale BOOLEAN, is_host BOOLEAN
) USING DELTA PARTITIONED BY (dt);

CREATE TABLE IF NOT EXISTS agent402.ecosystem.settlement_mpp (
  dt DATE, recipient STRING, sellers ARRAY<STRING>, intents ARRAY<STRING>,
  transfers BIGINT, volume_usdc DOUBLE, payers BIGINT, proven BOOLEAN,
  routable BOOLEAN, is_host BOOLEAN
) USING DELTA PARTITIONED BY (dt);

-- read_files infers from the NDJSON; the explicit schema above governs, so a
-- new column upstream lands as a schema mismatch rather than silently arriving.
INSERT INTO agent402.ecosystem.sellers
SELECT DATE'2026-09-11' AS dt, origin, display_name, homepage, primary_network,
       networks, tool_count, paid_tool_count, origin_responded, discovery_path,
       source, health, routable, mpp, stellar_pay_to, algorand_pay_to,
       pay_to_by_network, payment_networks_known, router_dispatch_eligible,
       router_dispatch_reason, CAST(fetched_at AS TIMESTAMP), crawl_error
FROM read_files('/Volumes/agent402/ecosystem/landing/dt=2026-09-11/sellers.ndjson', format => 'json');

INSERT INTO agent402.ecosystem.routes
SELECT DATE'2026-09-11', origin, route, method, price_usd, price_source,
       price_resolved_from, origin_declared_price,
       CAST(quote_observed_at AS TIMESTAMP), quote_carried_forward, networks,
       networks_inferred, CAST(networks_verified_at AS TIMESTAMP),
       method_inferred, method_corrected_from, url_template
FROM read_files('/Volumes/agent402/ecosystem/landing/dt=2026-09-11/routes.ndjson', format => 'json');

INSERT INTO agent402.ecosystem.settlement_base
SELECT DATE'2026-09-11', name, origins, homepage, pay_to, pay_to_count, network,
       calls_settled, total_usd, unique_buyers, endpoints
FROM read_files('/Volumes/agent402/ecosystem/landing/dt=2026-09-11/settlement_base.ndjson', format => 'json');

INSERT INTO agent402.ecosystem.settlement_solana
SELECT DATE'2026-09-11', pay_to, origins, credits, payers, truncated, stale, is_host
FROM read_files('/Volumes/agent402/ecosystem/landing/dt=2026-09-11/settlement_solana.ndjson', format => 'json');

INSERT INTO agent402.ecosystem.settlement_mpp
SELECT DATE'2026-09-11', recipient, sellers, intents, transfers, volume_usdc,
       payers, proven, routable, is_host
FROM read_files('/Volumes/agent402/ecosystem/landing/dt=2026-09-11/settlement_mpp.ndjson', format => 'json');

-- ---------------------------------------------------------------------------
-- Delta Sharing. This share is what a Marketplace listing points at, and the
-- same objects a self-hosted Delta Sharing server would serve - so the work is
-- not wasted if the listing application is still pending.
CREATE SHARE IF NOT EXISTS agent402_ecosystem
  COMMENT 'Daily x402 / MPP ecosystem: sellers, per-route pricing with provenance, settlement counts.';

ALTER SHARE agent402_ecosystem ADD TABLE agent402.ecosystem.sellers;
ALTER SHARE agent402_ecosystem ADD TABLE agent402.ecosystem.routes;
ALTER SHARE agent402_ecosystem ADD TABLE agent402.ecosystem.settlement_base;
ALTER SHARE agent402_ecosystem ADD TABLE agent402.ecosystem.settlement_solana;
ALTER SHARE agent402_ecosystem ADD TABLE agent402.ecosystem.settlement_mpp;

-- A named recipient for a direct (non-marketplace) share. Databricks issues an
-- activation link; for an open-source Delta Sharing client use the credential
-- file it returns.
-- CREATE RECIPIENT IF NOT EXISTS some_consumer;
-- GRANT SELECT ON SHARE agent402_ecosystem TO RECIPIENT some_consumer;

-- Sanity before submitting the listing.
SELECT 'sellers' AS t, COUNT(*) AS n FROM agent402.ecosystem.sellers WHERE dt = DATE'2026-09-11'
UNION ALL SELECT 'routes',            COUNT(*) FROM agent402.ecosystem.routes            WHERE dt = DATE'2026-09-11'
UNION ALL SELECT 'settlement_base',   COUNT(*) FROM agent402.ecosystem.settlement_base   WHERE dt = DATE'2026-09-11'
UNION ALL SELECT 'settlement_solana', COUNT(*) FROM agent402.ecosystem.settlement_solana WHERE dt = DATE'2026-09-11'
UNION ALL SELECT 'settlement_mpp',    COUNT(*) FROM agent402.ecosystem.settlement_mpp    WHERE dt = DATE'2026-09-11';
SHOW ALL IN SHARE agent402_ecosystem;
