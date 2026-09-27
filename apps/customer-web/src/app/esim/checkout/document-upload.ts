type Authorization = {
  id: string;
  upload: {
    mode: string;
    endpoint?: string;
    method?: string;
    headers?: Record<string, string>;
  };
};

/** Retain successful storage writes so a failed confirmation can be retried safely. */
export function createDocumentUploader() {
  const pending = new Map<
    string,
    { file: File; authorization: Authorization; uploaded: boolean }
  >();
  return async ({
    type,
    file,
    basePath,
    request,
    progress,
  }: {
    type: string;
    file: File;
    basePath: string;
    request: <T>(path: string, init?: RequestInit) => Promise<T>;
    progress: (message: string) => void;
  }) => {
    const key = `${basePath}/${type}`;
    let checkpoint = pending.get(key);
    if (!checkpoint || checkpoint.file !== file) {
      progress(`Preparing ${file.name}…`);
      const authorization = await request<Authorization>(basePath, {
        method: "POST",
        body: JSON.stringify({
          type,
          fileName: file.name,
          contentType: file.type || "application/pdf",
        }),
      });
      checkpoint = { file, authorization, uploaded: false };
      pending.set(key, checkpoint);
    }
    const { authorization } = checkpoint;
    if (!checkpoint.uploaded) {
      if (authorization.upload.mode !== "local-simulator") {
        if (
          authorization.upload.mode !== "s3-presigned" ||
          !authorization.upload.endpoint
        )
          throw new Error(
            "Private document storage is unavailable. Your other saved files are safe.",
          );
        progress(`Uploading ${file.name}…`);
        let response: Response;
        try {
          response = await fetch(authorization.upload.endpoint, {
            method: authorization.upload.method ?? "PUT",
            ...(authorization.upload.headers
              ? { headers: authorization.upload.headers }
              : {}),
            body: file,
          });
        } catch {
          // A new authorization on retry also handles an expired signed URL.
          pending.delete(key);
          throw new Error(
            `Could not upload ${file.name}. Check your connection and retry. Your other saved files are safe.`,
          );
        }
        if (!response.ok) {
          pending.delete(key);
          throw new Error(
            `Could not upload ${file.name}. Retry this file; your other saved files are safe.`,
          );
        }
      }
      checkpoint.uploaded = true;
    }
    progress(`Confirming ${file.name} is securely saved…`);
    await request(`${basePath}/${authorization.id}/confirm`, {
      method: "POST",
      body: "{}",
    });
    pending.delete(key);
    progress(`${file.name} securely saved.`);
    return {
      id: authorization.id,
      type,
      fileName: file.name,
      status: "UPLOADED",
      uploadVerified: true,
    };
  };
}
