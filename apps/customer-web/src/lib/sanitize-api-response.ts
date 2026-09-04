import { publicApiErrorMessage } from "@visa-compass/shared";

export async function sanitizeApiResponse(response: Response): Promise<Response> {
  if (response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string }; meta?: unknown };
    if (body.error) body.error.message = publicApiErrorMessage(body.error);
    return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
