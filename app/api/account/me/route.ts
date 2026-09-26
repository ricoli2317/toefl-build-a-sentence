import { NextResponse } from "next/server";
import { bearerToken, defaultRouteForRole, requireAuthenticatedAccount } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const account = await requireAuthenticatedAccount(bearerToken(request));
  if (account.error || !account.userId || !account.role) {
    const disabled = account.errorCode === "ACCOUNT_DISABLED";
    return NextResponse.json(
      {
        code: disabled ? "ACCOUNT_DISABLED" : "ACCOUNT_CONFIGURATION_ERROR",
        message: account.error ?? "Unauthorized"
      },
      { status: disabled || account.error === "Account configuration error" ? 403 : 401 }
    );
  }
  return NextResponse.json(
    {
      userId: account.userId,
      role: account.role,
      displayName: account.displayName ?? "",
      defaultRoute: defaultRouteForRole(account.role)
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
