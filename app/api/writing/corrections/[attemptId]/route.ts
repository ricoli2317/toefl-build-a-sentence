import { writingCorrectionRequest } from "@/lib/writingCorrectionApi.server";
export const dynamic = "force-dynamic";
type Context = { params: { attemptId: string } };
export const GET = (request: Request, { params }: Context) => writingCorrectionRequest(request, params.attemptId);
export const PATCH = (request: Request, { params }: Context) => writingCorrectionRequest(request, params.attemptId);
