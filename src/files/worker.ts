import { createTemplate, inspectWorkbook } from "./excel";
import { makeBackup, parseBackup } from "./backup";
import { errorText } from "../domain/calculations";
self.onmessage = async (event: MessageEvent) => {
  const { requestId, job, payload } = event.data;
  try {
    let value: unknown;
    if (job === "template")
      value = await createTemplate(payload.kind, payload.dataset);
    else if (job === "import")
      value = await inspectWorkbook(
        payload.buffer,
        payload.kind,
        payload.dataset,
        payload.revision,
      );
    else if (job === "backup")
      value = JSON.stringify(makeBackup(payload.state), null, 2);
    else if (job === "restore") {
      if (payload.buffer.byteLength > 50 * 1024 * 1024)
        throw Error("백업은 50MiB 이하 파일만 지원합니다.");
      value = parseBackup(
        new TextDecoder("utf-8", { fatal: true }).decode(payload.buffer),
      );
    } else throw Error("지원하지 않는 파일 작업입니다.");
    if (value instanceof ArrayBuffer)
      self.postMessage({ requestId, ok: true, value }, { transfer: [value] });
    else self.postMessage({ requestId, ok: true, value });
  } catch (e) {
    self.postMessage({ requestId, ok: false, error: errorText(e) });
  }
};
