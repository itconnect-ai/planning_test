export function runFileJob<T>(
  job: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      }),
      requestId = crypto.randomUUID();
    const timer = setTimeout(
      () =>
        finish(
          Error(
            "파일 검사가 30초를 넘었습니다. 파일을 나누어 다시 시도하세요.",
          ),
        ),
      30000,
    );
    const abort = () =>
      finish(Error("파일 처리를 취소했습니다. 기록은 변경되지 않았습니다."));
    function finish(error?: Error, value?: T) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(value as T);
    }
    worker.onmessage = (e) => {
      if (e.data.requestId !== requestId) return;
      if (e.data.ok) finish(undefined, e.data.value);
      else finish(Error(e.data.error));
    };
    worker.onerror = () =>
      finish(
        Error(
          "파일 처리 도구를 열지 못했습니다. 연결을 확인하고 다시 시도하세요.",
        ),
      );
    worker.onmessageerror = () =>
      finish(Error("파일 처리 결과를 읽지 못했습니다. 다시 시도하세요."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage({ requestId, job, payload });
    } catch {
      finish(Error("파일 처리 요청을 전달하지 못했습니다. 다시 시도하세요."));
    }
  });
}
export function downloadFile(data: BlobPart, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime })),
    anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
