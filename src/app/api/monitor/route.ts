import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const revalidate = 0;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  const [statsResult, rpcHealthResult] = await Promise.all([
    supabase.rpc("get_system_stats"),
    supabase.rpc("get_rpc_health"),
  ]);

  if (statsResult.error) return NextResponse.json({ error: statsResult.error.message }, { status: 500 });

  return NextResponse.json({
    ...statsResult.data,
    rpc_health: rpcHealthResult.data ?? [],
  });
}
