import { writingCorrectionRequest } from "@/lib/writingCorrectionApi.server";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => writingCorrectionRequest(request);
export const POST = (request: Request) => writingCorrectionRequest(request);
