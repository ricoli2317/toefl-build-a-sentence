import { NextResponse } from "next/server";
import { bearerToken, defaultRouteForRole, requireAuthenticatedAccount } from "@/lib/auth";
import { accountFailure, describeAccountFailure, reportAccountFailure } from "@/lib/accountCredentials";
import { accountFailureHttpStatus, classifyAccountVerificationError } from "@/lib/accountVerification";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const account = await requireAuthenticatedAccount(bearerToken(request));
    if (account.error || !account.userId || !account.role) {
      const failure = account.failure ?? accountFailure("ACCOUNT_VERIFICATION_FAILED", "identity_verification");
      reportAccountFailure(failure);
      return NextResponse.json(
        { code: failure.code, message: describeAccountFailure(failure.code) },
        { status: accountFailureHttpStatus(failure), headers: { "Cache-Control": "no-store" } }
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
  } catch (error) {
    const failure = classifyAccountVerificationError(error, "identity_verification");
    reportAccountFailure(failure);
    return NextResponse.json(
      { code: failure.code, message: describeAccountFailure(failure.code) },
      { status: accountFailureHttpStatus(failure), headers: { "Cache-Control": "no-store" } }
    );
  }
}
