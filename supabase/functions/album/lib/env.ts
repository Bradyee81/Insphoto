// Typed access to the Edge Function's environment. SUPABASE_URL,
// SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are auto-injected by
// Supabase into every Edge Function — only the R2 secrets need to be set
// manually (see SETUP.md). Fails fast with a clear message rather than
// letting a missing secret surface as a confusing downstream error.

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  get supabaseUrl() {
    return required("SUPABASE_URL");
  },
  get anonKey() {
    return required("SUPABASE_ANON_KEY");
  },
  get serviceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get r2AccountId() {
    return required("R2_ACCOUNT_ID");
  },
  get r2AccessKeyId() {
    return required("R2_ACCESS_KEY_ID");
  },
  get r2SecretAccessKey() {
    return required("R2_SECRET_ACCESS_KEY");
  },
  get r2Bucket() {
    return required("R2_BUCKET");
  },
  get r2PublicBase() {
    return required("R2_PUBLIC_BASE").replace(/\/$/, "");
  },
};
