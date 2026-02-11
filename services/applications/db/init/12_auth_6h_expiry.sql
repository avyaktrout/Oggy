-- Migration: Extend magic link expiry from 15 minutes to 6 hours
-- This updates the DEFAULT for new rows on existing deployments.
ALTER TABLE auth_magic_links
    ALTER COLUMN expires_at SET DEFAULT (now() + INTERVAL '6 hours');
