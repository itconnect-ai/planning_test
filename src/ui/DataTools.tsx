import { useEffect, useRef, useState } from "react";
import { type State } from "../domain/model";
import { errorText } from "../domain/calculations";
import { commitDataset, db, readSavedState, restoreState } from "../storage/db";
import { downloadFile, runFileJob } from "../files/client";
import { backupFilename } from "../files/backup";
import type { ImportKind, ImportResult } from "../files/excel";
type RestorePreview = { state: State; revision: number | null; name: string };
export default function DataTools({
  state,
  onCommitted,
  stale,
  reload,
  onBusy = () => {},
}: {
  state: State | null;
  onCommitted: (s: State, kind?: "restore") => void;
  stale: boolean;
  reload: () => Promise<void>;
  onBusy?: (busy: boolean) => void;
}) {
  const [kind, setKind] = useState<ImportKind>("sales"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [imported, setImported] = useState<ImportResult>(),
    [restore, setRestore] = useState<RestorePreview>(),
    [confirmed, setConfirmed] = useState(false);
  const controller = useRef<AbortController | null>(null),
    operation = useRef(0),
    writeBusy = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null),
    restoreInput = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      onBusy(false);
    },
    [],
  );
  const mismatch =
    stale ||
    (imported && imported.revision !== state?.revision) ||
    (restore && state && restore.revision !== state.revision);
  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    if (controller.current || writeBusy.current) return;
    const token = ++operation.current,
      c = new AbortController();
    controller.current = c;
    setBusy(true);
    onBusy(true);
    setError("");
    setMessage("");
    try {
      await action(c.signal);
    } catch (e) {
      if (token === operation.current) setError(errorText(e));
    } finally {
      if (token === operation.current) {
        controller.current = null;
        setBusy(false);
        onBusy(false);
      }
    }
  }
  function cancel() {
    if (writeBusy.current) return;
    controller.current?.abort();
    setImported(undefined);
    setRestore(undefined);
    setConfirmed(false);
  }
  async function template() {
    if (!state) return;
    await perform(async (signal) => {
      const buffer = await runFileJob<ArrayBuffer>(
        "template",
        { kind, dataset: state.dataset },
        signal,
      );
      downloadFile(
        buffer,
        kind === "sales" ? "판매기록_입력양식.xlsx" : "비용기록_입력양식.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      setMessage(
        "양식 내려받기를 시작했습니다. PC에 저장되었는지 확인하세요. 기존 기록은 바꾸지 않았습니다.",
      );
    });
  }
  async function importFile(file: File) {
    if (!state) return;
    setImported(undefined);
    setRestore(undefined);
    setConfirmed(false);
    await perform(async (signal) => {
      if (!/\.xlsx$/i.test(file.name))
        throw Error(".xlsx 프로그램 양식만 지원합니다.");
      if (file.size > 10 * 1024 * 1024)
        throw Error("엑셀은 10MiB 이하로 나누어 가져오세요.");
      const result = await runFileJob<ImportResult>(
        "import",
        {
          buffer: await file.arrayBuffer(),
          kind,
          dataset: state.dataset,
          revision: state.revision,
        },
        signal,
      );
      setImported(result);
    });
  }
  async function backup() {
    await perform(async (signal) => {
      const saved = await readSavedState();
      const text = await runFileJob<string>("backup", { state: saved }, signal);
      downloadFile(text, backupFilename(), "application/json;charset=utf-8");
      setMessage(
        `변경번호 ${saved.revision}의 마지막 저장 상태로 백업 내려받기를 시작했습니다. PC에 파일을 보관했는지 확인하세요.`,
      );
    });
  }
  async function inspectRestore(file: File) {
    setImported(undefined);
    setRestore(undefined);
    setConfirmed(false);
    await perform(async (signal) => {
      if (!/\.json$/i.test(file.name))
        throw Error("프로그램의 JSON 백업을 선택하세요.");
      if (file.size > 50 * 1024 * 1024)
        throw Error("백업은 50MiB 이하만 지원합니다.");
      const current = await db.appState.get("current");
      const revision = Number.isSafeInteger(current?.revision)
        ? current!.revision
        : null;
      const checked = await runFileJob<State>(
        "restore",
        { buffer: await file.arrayBuffer() },
        signal,
      );
      setRestore({ state: checked, revision, name: file.name });
    });
  }
  async function applyImport() {
    if (!state || !imported || imported.errors.length) return;
    await perform(async () => {
      if (stale || imported.revision !== state.revision)
        throw Error(
          "검사 후 기록이 변경되었습니다. 다시 읽고 파일을 다시 검사하세요.",
        );
      const saved = await readSavedState();
      if (saved.revision !== imported.revision)
        throw Error("다른 탭에서 변경했습니다. 파일을 다시 검사하세요.");
      if (!imported.added) {
        setMessage(
          `추가 0건 · 중복 제외 ${imported.skipped}건. 기록을 바꾸지 않았습니다.`,
        );
        setImported(undefined);
        return;
      }
      writeBusy.current = true;
      try {
        const next = await commitDataset(
          state,
          {
            ...state.dataset,
            sales: [...state.dataset.sales, ...imported.sales],
            expenses: [...state.dataset.expenses, ...imported.expenses],
          },
          [...imported.sales, ...imported.expenses].map((r) => r.date),
        );
        onCommitted(next);
        setMessage(
          `가져오기 완료: 추가 ${imported.added}건 · 중복 제외 ${imported.skipped}건. 수익성·손익·재고에 반영했습니다.`,
        );
        setImported(undefined);
      } finally {
        writeBusy.current = false;
      }
    });
  }
  async function applyRestore() {
    if (!restore) return;
    await perform(async () => {
      if (!confirmed)
        throw Error("현재 자료 전체를 백업으로 교체함을 확인하세요.");
      if (stale)
        throw Error(
          "다른 탭에서 변경했습니다. 다시 읽고 백업을 다시 검사하세요.",
        );
      writeBusy.current = true;
      try {
        const next = await restoreState(restore.revision, restore.state);
        onCommitted(next, "restore");
        setRestore(undefined);
        setImported(undefined);
        setConfirmed(false);
        setMessage(
          `백업 복원을 완료했습니다. 변경번호 ${next.revision} · 복원된 기록으로 결과를 다시 계산합니다.`,
        );
      } finally {
        writeBusy.current = false;
      }
    });
  }
  return (
    <div className="data-tools">
      <div className="notice">
        기록과 파일은 이 브라우저 안에서 처리합니다. 백업은 마지막 저장 상태만
        포함하며 미저장 입력은 포함하지 않습니다. PC 고장·브라우저 자료 삭제에
        대비해 파일을 별도 보관하세요.
      </div>
      {state && (
        <section className="panel">
          <h2>엑셀 양식·가져오기</h2>
          <p>
            판매와 비용 양식은 다릅니다. 새 기록을 추가하는 용도이며 기존 기록을
            엑셀로 수정하지 않습니다.
          </p>
          <div className="toolbar">
            <label>
              가져올 기록
              <select
                aria-label="가져올 기록"
                value={kind}
                disabled={busy}
                onChange={(e) => {
                  setKind(e.target.value as ImportKind);
                  setImported(undefined);
                  setError("");
                }}
              >
                <option value="sales">판매</option>
                <option value="expenses">비용</option>
              </select>
            </label>
            <button disabled={busy} onClick={() => void template()}>
              양식 내려받기
            </button>
            <button
              disabled={busy || stale}
              onClick={() => fileInput.current?.click()}
            >
              엑셀 파일 선택
            </button>
            <input
              ref={fileInput}
              aria-label="엑셀 파일"
              type="file"
              accept=".xlsx"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importFile(f);
              }}
            />
          </div>
          {imported && (
            <section className="preview">
              <h3>가져오기 검사 결과</h3>
              <p>
                새 기록 {imported.added}건 · 중복 제외 {imported.skipped}건 ·
                오류 {imported.errors.length}건
              </p>
              <p>
                오류가 하나라도 있으면 파일 전체를 반영하지 않습니다. 검사만으로
                기록을 바꾸지 않습니다.
              </p>
              {imported.errors.length > 0 && (
                <div className="file-errors" role="alert">
                  <ul>
                    {imported.errors.map((e, i) => (
                      <li key={i}>
                        {e.row}행: {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button
                className="primary"
                disabled={
                  busy || Boolean(mismatch) || imported.errors.length > 0
                }
                onClick={() => void applyImport()}
              >
                가져오기 확정
              </button>
              <button disabled={busy} onClick={() => setImported(undefined)}>
                가져오기 취소
              </button>
            </section>
          )}
        </section>
      )}
      <section className="panel">
        <h2>전체 백업·복원</h2>
        <p>
          복원은 현재 기록과 합치지 않고 백업 내용으로 전체 교체합니다. 복원
          전에 현재 백업을 보관하세요. 파일 생성일과 영업 기록 기준일은
          다릅니다.
        </p>
        <div className="toolbar">
          <button disabled={busy || !state} onClick={() => void backup()}>
            전체 백업 내려받기
          </button>
          <button disabled={busy} onClick={() => restoreInput.current?.click()}>
            복원 파일 선택
          </button>
          <input
            ref={restoreInput}
            aria-label="백업 복원 파일"
            type="file"
            accept=".json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void inspectRestore(f);
            }}
          />
        </div>
        {restore && (
          <section className="preview">
            <h3>복원 전 확인</h3>
            <p>{restore.name}</p>
            <p>
              백업 파일 생성: {restore.state.savedAt} · 업무 기준일:{" "}
              {restore.state.dataset.meta.as_of}
            </p>
            <p>
              현재 판매 {state?.dataset.sales.length ?? "읽기 실패"}건 / 비용{" "}
              {state?.dataset.expenses.length ?? "읽기 실패"}건 / 재고{" "}
              {state?.dataset.inventory_events.length ?? "읽기 실패"}건 → 복원
              후 판매 {restore.state.dataset.sales.length}건 / 비용{" "}
              {restore.state.dataset.expenses.length}건 / 재고{" "}
              {restore.state.dataset.inventory_events.length}건
            </p>
            {!restore.state.dataset.sales.length &&
              !restore.state.dataset.expenses.length &&
              !restore.state.dataset.inventory_events.length && (
                <p className="negative">
                  유효한 빈 백업입니다. 현재 판매·비용·재고 기록이 모두
                  비워집니다.
                </p>
              )}
            <label className="check-row">
              <input
                type="checkbox"
                disabled={busy}
                checked={confirmed}
                onChange={(e) => {
                  setConfirmed(e.target.checked);
                  setError("");
                }}
              />
              현재 기록 전체가 교체되며 기존 입력은 폐기됨을 확인했습니다
            </label>
            <button
              className="primary"
              disabled={busy || Boolean(mismatch)}
              onClick={() => void applyRestore()}
            >
              전체 교체 복원
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setRestore(undefined);
                setConfirmed(false);
              }}
            >
              복원 취소
            </button>
          </section>
        )}
      </section>
      {mismatch && (
        <div className="notice">
          파일 검사 이후 기록이 변경되었습니다. 다시 읽고 파일을 다시
          검사하세요.{" "}
          <button
            disabled={busy}
            onClick={() => {
              setImported(undefined);
              setRestore(undefined);
              setConfirmed(false);
              void reload();
            }}
          >
            새로 읽기
          </button>
        </div>
      )}
      {busy && (
        <p role="status">
          파일 처리 중… (최대 30초){" "}
          <button disabled={writeBusy.current} onClick={cancel}>
            파일 처리 취소
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
    </div>
  );
}
