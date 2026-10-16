// Self-hosted Supabase for feed analytics (supabase.omgithub.com).
// Publishable (anon) key — safe in the browser. RLS: feed_events is
// INSERT-only for anon; stats come from the aggregate-only feed_stats() RPC.
export const SUPABASE_URL = 'https://supabase.omgithub.com';
export const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg5MDAwMzEyLCJleHAiOjE5NDY2ODAzMTJ9.-Fck227qOVB2d8bp5JR_0r7OPU-suuzLYtfUcqVdHTs';
