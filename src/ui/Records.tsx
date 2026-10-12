import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { type Dataset } from "../domain/model";
import {
  errorText,
  money,
  quantity,
  rowsIn,
  stock,
  sum,
} from "../domain/calculations";
import {
  expenseCategories,
  prepareExpense,
  prepareInventory,
  type Expense,
  type EventKind,
  type InventoryEvent,
  type InventoryInput,
} from "../domain/operations";

export function ExpenseView({
  d,
  from,
  to,
  edit,
  remove,
  add,
}: {
  d: Dataset;
  from: string;
  to: string;
  edit: (e: Expense) => void;
  remove: (e: Expense) => void;
  add: () => void;
}) {
  const rows = rowsIn(d.expenses, from, to);
  return (
    <section className="panel">
      <div className="toolbar">
        <h2>
          비용 기록 · {rows.length}건 · {money(sum(rows.map((e) => e.amount)))}
        </h2>
        <button className="primary" onClick={add}>
          비용 입력
        </button>
      </div>
      <p>
        귀속일은 손익에 반영할 날짜입니다. 재료 매입은 재고의 입고에서
        기록하세요. 새 비용은 해당 날짜에 전액 반영합니다.
      </p>
      <div className="toolbar">
        {expenseCategories(d).map((c) => (
          <span key={c}>
            {c}:{" "}
            {money(
              sum(rows.filter((e) => e.category === c).map((e) => e.amount)),
            )}
          </span>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {["귀속일", "비용항목", "금액", "출처", "기록 관리"].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.expense_id}>
                <td>{e.date}</td>
                <td>{e.category}</td>
                <td>{money(e.amount)}</td>
                <td>{String(e.source ?? "제공 기록")}</td>
                <td className="row-actions">
                  <button onClick={() => edit(e)}>수정</button>
                  <button onClick={() => remove(e)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="empty">선택 기간 비용 기록이 없습니다.</p>}
    </section>
  );
}

function Dialog({
  title,
  children,
  submit,
  close,
  dirty,
  stale,
  reload,
  action,
}: {
  title: string;
  children: ReactNode;
  submit: () => Promise<void>;
  close: () => void;
  dirty: boolean;
  stale: boolean;
  reload: () => Promise<void>;
  action: string;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    busyRef = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const origin = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    ref.current?.showModal();
    const target = origin.current;
    return () => {
      target?.focus();
    };
  }, []);
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, [dirty]);
  function cancel() {
    if (
      !busyRef.current &&
      (!dirty || window.confirm("입력 중인 내용을 버릴까요?"))
    )
      close();
  }
  async function run(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    setError("");
    busyRef.current = true;
    setBusy(true);
    try {
      if (stale)
        throw Error("다른 탭에서 변경했습니다. 새로 읽기 후 다시 확인하세요.");
      await submit();
    } catch (e) {
      setError(errorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={ref}
      aria-labelledby="record-title"
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <form
        noValidate
        onChange={() => setError("")}
        onSubmit={(e) => void run(e)}
      >
        <div className="dialog-head">
          <h2 id="record-title">{title}</h2>
          <button type="button" disabled={busy} onClick={cancel}>
            닫기
          </button>
        </div>
        <div className="dialog-body">
          {children}
          {stale && (
            <div className="notice">
              다른 탭의 변경을 먼저 읽어주세요. 입력값은 유지됩니다.{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() => void reload()}
              >
                새로 읽기
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" onClick={cancel} disabled={busy}>
            취소
          </button>
          <button className="primary" type="submit" disabled={busy || stale}>
            {busy ? "처리 중…" : action}
          </button>
        </div>
      </form>
    </dialog>
  );
}
export function DeleteDialog({
  label,
  id,
  remove,
  close,
  stale,
  reload,
}: {
  label: string;
  id: string;
  remove: () => Promise<void>;
  close: () => void;
  stale: boolean;
  reload: () => Promise<void>;
}) {
  return (
    <Dialog
      title="기록 삭제 확인"
      action="삭제 확정"
      submit={remove}
      close={close}
      dirty={false}
      stale={stale}
      reload={reload}
    >
      <p>{label}</p>
      <small>기록 ID: {id}</small>
      <p>
        이 기록 한 건을 삭제하고 손익·사용량을 다시 계산합니다. 취소하면 그대로
        유지합니다.
      </p>
    </Dialog>
  );
}
export function RecordDialog({
  d,
  kind,
  material,
  existing,
  defaultDate,
  save,
  close,
  stale,
  reload,
}: {
  d: Dataset;
  kind: "비용" | EventKind;
  material?: string;
  existing?: Expense;
  defaultDate: string;
  save: (r: Expense | InventoryEvent) => Promise<void>;
  close: () => void;
  stale: boolean;
  reload: () => Promise<void>;
}) {
  const initialMaterial =
    d.materials.find((m) => m.material_id === material) ?? d.materials[0];
  const [input, setInput] = useState<InventoryInput>({
    date: existing?.date ?? defaultDate,
    material_id: initialMaterial?.material_id ?? "",
    quantity: "",
    supplier_id: initialMaterial?.supplier_id ?? "",
    unit_cost: "",
    reason: "",
    memo: "",
    confirmed: false,
  });
  const [category, setCategory] = useState(
      existing?.category ?? expenseCategories(d)[0] ?? "",
    ),
    [amount, setAmount] = useState(existing?.amount ?? ""),
    [duplicate, setDuplicate] = useState(false);
  const original = useRef(JSON.stringify({ input, category, amount }));
  const dirty =
    original.current !== JSON.stringify({ input, category, amount });
  const m = d.materials.find((m) => m.material_id === input.material_id);
  function update<K extends keyof InventoryInput>(
    key: K,
    value: InventoryInput[K],
  ) {
    setInput((i) => ({
      ...i,
      [key]: value,
      confirmed: key === "confirmed" ? Boolean(value) : false,
    }));
    setDuplicate(false);
  }
  const title =
    kind === "비용"
      ? existing
        ? "비용 수정"
        : "비용 입력"
      : kind === "실사조정"
        ? "실제 재고 입력 (실사)"
        : `${kind} 기록`;
  let event: InventoryEvent | undefined,
    previewError = "";
  if (kind !== "비용")
    try {
      event = prepareInventory(d, kind, { ...input, confirmed: true });
    } catch (e) {
      previewError = errorText(e);
    }
  const before =
    kind === "비용"
      ? undefined
      : stock(d, input.date).find(
          (s) => s.material.material_id === input.material_id,
        );
  const after = event
    ? stock(
        { ...d, inventory_events: [...d.inventory_events, event] },
        input.date,
      ).find((s) => s.material.material_id === input.material_id)
    : undefined;
  const isDuplicate =
    kind === "비용" &&
    d.expenses.some(
      (e) =>
        e.expense_id !== existing?.expense_id &&
        e.date === input.date &&
        e.category === category &&
        e.amount === amount.replaceAll(",", "").trim(),
    );
  return (
    <Dialog
      title={title}
      action={
        kind === "비용"
          ? existing
            ? "비용 수정 저장"
            : "비용 저장"
          : kind === "실사조정"
            ? "실사 확정"
            : `${kind} 저장`
      }
      close={close}
      dirty={dirty}
      stale={stale}
      reload={reload}
      submit={async () => {
        const result =
          kind === "비용"
            ? prepareExpense(
                d,
                { date: input.date, category, amount },
                existing,
                duplicate,
              )
            : prepareInventory(d, kind, input);
        await save(result);
      }}
    >
      <label>
        {kind === "비용" ? "귀속일" : "기록일"}
        <input
          type="date"
          value={input.date}
          onChange={(e) => update("date", e.target.value)}
        />
      </label>
      {kind === "비용" ? (
        <>
          <p>
            손익에 반영할 날짜를 선택하세요. 월별로 자동 나누지 않으며 재고는
            바뀌지 않습니다.
          </p>
          <label>
            비용항목
            <select
              aria-label="비용항목"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setDuplicate(false);
              }}
            >
              {expenseCategories(d).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            비용 금액 (원)
            <input
              inputMode="numeric"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setDuplicate(false);
              }}
            />
          </label>
          {isDuplicate && (
            <div className="notice">
              <p>같은 날짜·항목·금액의 비용이 있습니다.</p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={duplicate}
                  onChange={(e) => setDuplicate(e.target.checked)}
                />
                기존 비용과 별도 지출임을 확인했습니다
              </label>
            </div>
          )}
        </>
      ) : (
        <>
          <label>
            재료
            <select
              aria-label="재료"
              value={input.material_id}
              onChange={(e) => {
                update("material_id", e.target.value);
                setInput((i) => ({
                  ...i,
                  supplier_id:
                    d.materials.find((m) => m.material_id === e.target.value)
                      ?.supplier_id ?? "",
                }));
              }}
            >
              {d.materials.map((m) => (
                <option key={m.material_id} value={m.material_id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {kind === "실사조정" ? "실측 수량" : `${kind} 수량`} ({m?.unit})
            <input
              inputMode="decimal"
              value={input.quantity}
              onChange={(e) => update("quantity", e.target.value)}
            />
          </label>
          <p>
            단위는 {m?.unit}로 고정됩니다. 1kg은 1,000g, 1L는 1,000ml로
            입력하세요. 개는 정수, g·ml는 소수 3자리까지입니다.
          </p>
          {kind === "입고" ? (
            <>
              <label>
                공급사
                <select
                  aria-label="공급사"
                  value={input.supplier_id}
                  onChange={(e) => update("supplier_id", e.target.value)}
                >
                  {d.suppliers.map((s) => (
                    <option key={s.supplier_id} value={s.supplier_id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                입고 단위당 가격 (원, 선택)
                <input
                  inputMode="decimal"
                  value={input.unit_cost}
                  onChange={(e) => update("unit_cost", e.target.value)}
                />
              </label>
              <label>
                메모 (선택)
                <input
                  value={input.memo}
                  onChange={(e) => update("memo", e.target.value)}
                />
              </label>
              <p>
                입고 가격은 이 기록에만 보관합니다. 가격이력·과거 원가와 손익
                비용은 자동 변경하지 않습니다.
              </p>
            </>
          ) : (
            <label>
              사유
              <input
                value={input.reason}
                onChange={(e) => update("reason", e.target.value)}
              />
            </label>
          )}
          <section className="preview">
            <h3>저장 전 미리보기</h3>
            <p>
              기록 전 마감 잔량:{" "}
              {before?.balance !== null && before?.balance !== undefined
                ? quantity(before.balance)
                : "계산 불가"}{" "}
              {m?.unit}
            </p>
            {event ? (
              <>
                <p>
                  기록 후 마감 잔량:{" "}
                  {after?.balance !== null && after?.balance !== undefined
                    ? quantity(after.balance)
                    : "계산 불가"}{" "}
                  {m?.unit}
                </p>
                {kind === "실사조정" && (
                  <p>
                    실측과의 차이: {quantity(event.quantity)} {m?.unit}
                  </p>
                )}
                {after?.balance?.lt(0) && (
                  <p className="negative">
                    음수 잔량이 예상됩니다. 실제 기록이라면 저장할 수 있습니다.
                  </p>
                )}
              </>
            ) : (
              <p>{previewError}</p>
            )}
            <small>
              미리보기만으로 저장하지 않습니다. 같은 날 실사가 있으면 그 마감
              실측값을 유지합니다.
            </small>
          </section>
          {kind === "폐기" && (
            <p>
              폐기는 수량에만 반영하며 폐기 손실액을 손익에서 추가 차감하지
              않습니다.
            </p>
          )}
          {kind === "실사조정" && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={input.confirmed}
                onChange={(e) => update("confirmed", e.target.checked)}
              />
              영업 종료 시점의 실제 수량이며 과거 날짜의 실사는 이후 결과를 바꿀
              수 있음을 확인했습니다
            </label>
          )}
        </>
      )}
    </Dialog>
  );
}
