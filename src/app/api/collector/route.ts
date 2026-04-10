import { NextResponse } from "next/server";

export const revalidate = 0;
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch("http://127.0.0.1:3096/health", {
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    console.error("[collector] health fetch failed:", e?.message);
    return NextResponse.json({ status: "down", error: e?.message }, { status: 503 });
  }
}
