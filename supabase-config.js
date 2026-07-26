// Supabase project config for MathMADics.
//
// Get these from: Supabase dashboard -> Project Settings -> Data API (and
// API Keys). Copy the Project URL and the "anon / public" key below.
//
// Until these are replaced with real values, every cloud feature stays off: the
// score boards are cloud-only now, so with no config there is no sign-in, no
// network, and no boards at all.
//
// The anon key is NOT a secret. It identifies the project for the browser; it
// authorises nothing on its own. Access is controlled entirely by the
// Row-Level Security policies in schema.sql.

export const supabaseConfig = {
  url: "https://bazlckeaugrcujdxdmtn.supabase.co",
  anonKey: "sb_publishable_2zGZbUt35SidpwclkNzZYg_u3cJta13"
};

// supabase-js is loaded from a CDN as an ES module. Pin the major version.
export const SDK_URL = "https://esm.sh/@supabase/supabase-js@2";
