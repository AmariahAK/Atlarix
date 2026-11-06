-- No user writes ledger rows (audit 2026-11-06, Fix B). APPLY ONLY AFTER the proxy
-- that charges signed-in users through debit_wallet_service (with the user id from
-- the JWT it verified) is live on Railway AND the Lambda failover: until then the
-- proxy still calls debit_wallet with the user's JWT, and this would refuse every
-- user charge. Nothing else calls debit_wallet (grepped every repo 2026-11-06).
REVOKE EXECUTE ON FUNCTION public.debit_wallet(text, bigint, text, text) FROM authenticated, anon, PUBLIC;
