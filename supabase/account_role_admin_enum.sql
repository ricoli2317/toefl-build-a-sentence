-- Step 1. Run this file by itself and let it commit before the next migration.
-- PostgreSQL requires a newly-added enum value to be committed before functions
-- and policies can safely reference it.
alter type public.user_role add value if not exists 'admin';
