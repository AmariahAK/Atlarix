-- Migration 002: Add fingerprint columns to diagrams table
-- For diagram staleness detection feature
-- Date: 2026-01-02

-- Add fingerprint columns to diagrams table (SQLite uses ALTER TABLE ADD COLUMN)
ALTER TABLE diagrams ADD COLUMN fingerprint_hash TEXT;
ALTER TABLE diagrams ADD COLUMN fingerprint_data TEXT;
ALTER TABLE diagrams ADD COLUMN created_from_file_count INTEGER DEFAULT 0;

-- Note: SQLite doesn't support adding multiple columns in one statement,
-- nor adding NOT NULL constraints to new columns directly.
-- These columns are nullable which is fine for backwards compatibility.
