import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ChartLine,
  BookOpen,
  Receipt,
  Package,
  Plus,
  ArrowRight,
  Coffee,
  FloppyDisk,
  WarningCircle,
} from "@phosphor-icons/react";
import { type State, type Dataset, type Sale, todayKST } from "../domain/model";
import {
  D,
  dateStatus,
  errorText,
  money,
  percent,
  period,
  prepareSale,
  priceAt,
  profitAndLoss,
  quantity,
  recipe,
  rowsIn,
  stock,
  sum,
  totals,
  type SaleInput,
} from "../domain/calculations";
import { appendSale, commitDataset, loadOrSeed } from "../storage/db";
import {
  replaceRecord,
  type Expense,
  type EventKind,
} from "../domain/operations";
import { ExpenseView, RecordDialog, DeleteDialog } from "./Records";
const DataTools = lazy(() => import("./DataTools"));
const screens = [
  ["dashboard", "대시보드 / 기간 손익", ChartLine],
  ["menus", "메뉴 수익성", BookOpen],
  ["sales", "판매 기록", Receipt],
  ["inventory", "재료 잔량", Package],
  ["data", "백업 및 데이터 관리", FloppyDisk],
] as const;
function startPage() {
  return screens.some((s) => s[0] === location.hash.slice(1))
    ? location.hash.slice(1)
    : "dashboard";
}
export default function App() {
  const [state, setState] = useReducer(
    (_old: State | null, next: State) => next,
    null,
  );
  const [fatal, setFatal] = useState("");
  const [page, setPage] = useState(startPage);
  const [mode, setMode] = useState("month");
  const [value, setValue] = useState("2026-09");
  const [inventoryDate, setInventoryDate] = useState("2026-09-18");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Sale>();
  const [recordTab, setRecordTab] = useState("sales");
  const [recordForm, setRecordForm] = useState<{
    kind: "비용" | EventKind;
    material?: string;
    expense?: Expense;
  }>();
  const [deleting, setDeleting] = useState<{
    kind: "sales" | "expenses";
    id: string;
    label: string;
    date: string;
  }>();
  const [message, setMessage] = useState("");
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fileBusy, setFileBusy] = useState(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  async function reload() {
    setLoading(true);
    try {
      setState(await loadOrSeed());
      setFatal("");
      setStale(false);
    } catch (e) {
      setFatal(
        "저장 자료를 열지 못했습니다. 기존 자료는 덮어쓰지 않았습니다. " +
          errorText(e),
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    const h = () => setPage(startPage());
    window.addEventListener("hashchange", h);
    if ("BroadcastChannel" in window) {
      channel.current = new BroadcastChannel("prep-cafe-updates");
      channel.current.onmessage = (event) => {
        setStale(true);
        if (event.data.kind === "restore") {
          setFormOpen(false);
          setEditing(undefined);
          setRecordForm(undefined);
          setDeleting(undefined);
          setMessage(
            "다른 탭에서 복원했습니다. 이전 입력을 폐기했습니다. 새로 읽어주세요.",
          );
        }
      };
    }
    return () => {
      window.removeEventListener("hashchange", h);
      channel.current?.close();
    };
  }, []);
  const range = useMemo(() => {
    try {
      return { ...period(mode, value), error: "" };
    } catch (e) {
      return { from: "", to: "", error: errorText(e) };
    }
  }, [mode, value]);
  const stocks = useMemo(
    () => (state ? stock(state.dataset, inventoryDate) : []),
    [state, inventoryDate],
  );
  // The dashboard's inventory shares the selected reporting reference date.
  // A partially recorded sample month uses its latest actual date, never a forecast.
  useEffect(() => {
    if (!state || range.error || page === "inventory") return;
    if (mode === "day") {
      setInventoryDate(range.to);
      return;
    }
    const d = state.dataset;
    const recordedDates = [
      d.meta.as_of,
      ...d.sales.map((s) => s.date),
      ...d.inventory_events.map((e) => e.date),
      ...d.expenses.map((e) => e.date),
    ]
      .filter((date) => date >= range.from && date <= range.to)
      .sort();
    setInventoryDate(recordedDates.at(-1) ?? range.to);
  }, [state, range.from, range.to, range.error, mode, page]);
  function fileCommitted(next: State, kind?: "restore") {
    setMessage(
      !state && kind === "restore"
        ? "백업 복원을 완료했습니다. 기록을 다시 계산했습니다."
        : "",
    );
    setState(next);
    setFatal("");
    setStale(false);
    setFormOpen(false);
    setEditing(undefined);
    setRecordForm(undefined);
    setDeleting(undefined);
    try {
      channel.current?.postMessage({ revision: next.revision, kind });
    } catch {
      /* Transaction revision check remains authoritative. */
    }
  }
  if (!state)
    return (
      <main className="startup">
        <h1>프렙 카페</h1>
        <p role={fatal ? "alert" : "status"}>{fatal || "저장 자료 확인 중…"}</p>
        {fatal && <button onClick={() => void reload()}>다시 읽기</button>}
        {fatal && (
          <Suspense fallback={<p>복원 도구 여는 중…</p>}>
            <DataTools
              state={null}
              stale={stale}
              reload={reload}
              onCommitted={(next) => fileCommitted(next, "restore")}
              onBusy={setFileBusy}
            />
          </Suspense>
        )}
      </main>
    );
  const d = state.dataset;
  const sales = rowsIn(d.sales, range.from, range.to);
  const pl = profitAndLoss(d, range.from, range.to);
  const need = stocks.filter((s) => s.balance === null || s.balance.lte(0));
  const navigate = (p: string) => {
    location.hash = p;
    setPage(p);
  };
  function changeMode(next: string) {
    setMode(next);
    setValue(next === "day" ? value.slice(0, 7) + "-18" : value.slice(0, 7));
  }
  async function save(s: Sale) {
    try {
      const next = editing
        ? await commitDataset(
            state!,
            {
              ...d,
              sales: replaceRecord(d.sales, "sale_id", editing.sale_id, s),
            },
            [
              d.sales.find((row) => row.sale_id === editing.sale_id)?.date ??
                editing.date,
              s.date,
            ],
          )
        : await appendSale(state!, s);
      setState(next);
      try {
        channel.current?.postMessage({ revision: next.revision });
      } catch {
        /* Advisory only; the transaction revision check remains authoritative. */
      }
      setMessage("판매를 저장했습니다. 수익성·손익·재료 잔량에 반영했습니다.");
      setMode("day");
      setValue(s.date);
      setInventoryDate(s.date);
      setFormOpen(false);
      setEditing(undefined);
      addButton.current?.focus();
    } catch (e) {
      throw Error(errorText(e));
    }
  }
  async function commit(dataset: Dataset, dates: string[], message: string) {
    const next = await commitDataset(state!, dataset, dates);
    setState(next);
    try {
      channel.current?.postMessage({ revision: next.revision });
    } catch {
      /* revision transaction remains authoritative */
    }
    setMessage(message);
  }
  return (
    <div className="app">
      <aside>
        <div className="brand">
          <Coffee size={32} weight="fill" />
          <div>
            <strong>프렙 카페</strong>
            <small>운영 기록</small>
          </div>
        </div>
        <div className="storage">
          <FloppyDisk size={18} />
          <span>
            이 브라우저에 저장
            <br />
            <b>변경번호 {state.revision}</b>
          </span>
        </div>
        <nav>
          {screens.map(([id, label, Icon]) => (
            <a
              key={id}
              href={"#" + id}
              onClick={(e) => {
                if (fileBusy) e.preventDefault();
              }}
              aria-disabled={fileBusy}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={22} />
              {label}
            </a>
          ))}
        </nav>
        <div className="aside-note">
          <strong>한 매장 · 한 PC</strong>
          <p>
            기록은 현재 주소의 브라우저에 보관됩니다. 사이트 자료를 지우면
            기록도 삭제됩니다.
          </p>
          <small>백업 파일을 PC 밖에도 별도 보관하세요.</small>
        </div>
      </aside>
      <div className="workspace">
        <header>
          <span className="badge">프렙 카페 · 로컬 PC</span>
          <span>
            샘플 마감 기준 <b>{d.meta.as_of}</b>
          </span>
          <button
            className="primary"
            ref={addButton}
            onClick={() => {
              setMessage("");
              setFormOpen(true);
            }}
            disabled={loading || stale || fileBusy}
          >
            <Plus size={18} />
            판매 입력
          </button>
        </header>
        <main>
          <div className="page-title">
            <div>
              <h1>{screens.find((s) => s[0] === page)?.[1]}</h1>
              <p>가상 매장 샘플 · 원 / 부가세 제외</p>
            </div>
            <span className="badge">
              메뉴 {d.menus.length}개 · 재료 {d.materials.length}개
            </span>
          </div>
          <div className="sample-note">
            자료 기간 {d.meta.start_date}~{d.meta.as_of} · 전체 판매{" "}
            <b data-testid="sale-count">
              {d.sales.length.toLocaleString("ko-KR")}
            </b>
            건 · 비용 {d.expenses.length.toLocaleString("ko-KR")}건 · 재고{" "}
            {d.inventory_events.length.toLocaleString("ko-KR")}건
          </div>
          {message && (
            <p className="success" role="status">
              {message}
            </p>
          )}
          {stale && (
            <div className="notice" role="alert">
              다른 탭에서 변경했습니다. 저장 전에 새로 읽고 입력을 다시
              확인하세요.{" "}
              <button onClick={() => void reload()}>새로 읽기</button>
            </div>
          )}
          {fatal && (
            <div className="error" role="alert">
              {fatal}
              <button onClick={() => void reload()}>다시 읽기</button>
            </div>
          )}
          {page === "data" ? (
            <Suspense fallback={<p role="status">파일 도구 여는 중…</p>}>
              <DataTools
                state={state}
                stale={stale}
                reload={reload}
                onBusy={setFileBusy}
                onCommitted={(next, kind) => fileCommitted(next, kind)}
              />
            </Suspense>
          ) : page !== "inventory" ? (
            <>
              <section className="toolbar">
                <label>
                  조회 단위
                  <select
                    aria-label="조회 단위"
                    value={mode}
                    onChange={(e) => changeMode(e.target.value)}
                  >
                    <option value="day">일별</option>
                    <option value="month">월별</option>
                  </select>
                </label>
                <label>
                  {mode === "day" ? "조회 날짜" : "조회 월"}
                  <input
                    type={mode === "day" ? "date" : "month"}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </label>
                <span>
                  {range.from} ~ {range.to}
                </span>
              </section>
              {range.error ? (
                <p role="alert" className="error">
                  {range.error}
                </p>
              ) : (
                <>
                  <PeriodStatus
                    d={d}
                    from={range.from}
                    to={range.to}
                    review={state.reviewRequiredDates}
                  />
                  {page === "dashboard" ? (
                    <>
                      <div className="metrics">
                        <Metric label="순매출" value={money(pl.net)} />
                        <Metric
                          label="재료·포장·수수료"
                          value={money(pl.direct)}
                        />
                        <Metric label="기간 비용" value={money(pl.cost)} />
                        <Metric
                          label="운영 참고 손익"
                          value={money(pl.income)}
                          positive={pl.income.gte(0)}
                        />
                      </div>
                      <div className="columns">
                        <DailyTable
                          d={d}
                          from={range.from}
                          to={range.to}
                          review={state.reviewRequiredDates}
                        />
                        <div>
                          <section className="panel">
                            <h2>기간 비용 명세</h2>
                            <p>
                              제공 비용은 월비용을 일별 배분한 기록입니다.
                              월계획·입고 대금은 다시 차감하지 않습니다.
                            </p>
                            {[
                              ...new Set(pl.expenses.map((e) => e.category)),
                            ].map((c) => (
                              <div className="detail-line" key={c}>
                                <span>{c}</span>
                                <b>
                                  {money(
                                    sum(
                                      pl.expenses
                                        .filter((e) => e.category === c)
                                        .map((e) => e.amount),
                                    ),
                                  )}
                                </b>
                              </div>
                            ))}
                            {!pl.expenses.length && (
                              <p>해당 기간 비용 기록 없음</p>
                            )}
                            <p>손익률 {percent(pl.income, pl.net)}</p>
                          </section>
                          <section className="panel">
                            <h2>부족·확인 대상 재료 {need.length}개</h2>
                            <p>재고 기준일 {inventoryDate}</p>
                            {need.length ? (
                              need.map((s) => (
                                <p
                                  className="negative"
                                  key={s.material.material_id}
                                >
                                  {s.material.name}:{" "}
                                  {s.balance === null
                                    ? "계산 불가"
                                    : quantity(s.balance) +
                                      " " +
                                      s.material.unit}
                                  <button
                                    onClick={() =>
                                      setRecordForm({
                                        kind: "실사조정",
                                        material: s.material.material_id,
                                      })
                                    }
                                  >
                                    실사 입력
                                  </button>
                                </p>
                              ))
                            ) : (
                              <p>
                                0 이하인 재료가 없습니다. 향후 충분함을 뜻하지
                                않습니다.
                              </p>
                            )}
                            <button onClick={() => navigate("inventory")}>
                              재료 잔량 확인 <ArrowRight />
                            </button>
                          </section>
                        </div>
                      </div>
                    </>
                  ) : page === "menus" ? (
                    <MenuView d={d} sales={sales} />
                  ) : (
                    <>
                      <div className="toolbar" aria-label="기록 종류">
                        <button
                          aria-pressed={recordTab === "sales"}
                          onClick={() => setRecordTab("sales")}
                        >
                          판매 기록
                        </button>
                        <button
                          aria-pressed={recordTab === "expenses"}
                          onClick={() => setRecordTab("expenses")}
                        >
                          비용 기록
                        </button>
                      </div>
                      {recordTab === "sales" ? (
                        <SalesView
                          d={d}
                          sales={sales}
                          edit={(s) => {
                            setEditing(s);
                            setFormOpen(true);
                          }}
                          remove={(s) =>
                            setDeleting({
                              kind: "sales",
                              id: s.sale_id,
                              date: s.date,
                              label: `${s.date} ${d.menus.find((m) => m.menu_id === s.menu_id)?.name} ${s.channel} ${s.quantity}개`,
                            })
                          }
                        />
                      ) : (
                        <ExpenseView
                          d={d}
                          from={range.from}
                          to={range.to}
                          edit={(expense) =>
                            setRecordForm({ kind: "비용", expense })
                          }
                          add={() => setRecordForm({ kind: "비용" })}
                          remove={(e) =>
                            setDeleting({
                              kind: "expenses",
                              id: e.expense_id,
                              date: e.date,
                              label: `${e.date} ${e.category} ${money(e.amount)}`,
                            })
                          }
                        />
                      )}
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            <InventoryView
              d={d}
              stocks={stocks}
              date={inventoryDate}
              setDate={setInventoryDate}
              record={(kind, material) => setRecordForm({ kind, material })}
            />
          )}
          <footer>
            프렙 카페 · 마지막 저장{" "}
            {new Date(state.savedAt).toLocaleString("ko-KR", {
              timeZone: "Asia/Seoul",
            })}{" "}
            · 변경번호 {state.revision}
            <br />
            표시는 반올림되어 행의 합과 총합이 다를 수 있습니다. 손익은 세금
            신고용 확정 이익이 아닙니다.
          </footer>
        </main>
      </div>
      {formOpen && (
        <SaleForm
          d={d}
          existing={editing}
          defaultDate={mode === "day" ? value : inventoryDate}
          save={save}
          stale={stale}
          reload={reload}
          onClose={() => {
            setFormOpen(false);
            setEditing(undefined);
            addButton.current?.focus();
          }}
        />
      )}
      {recordForm && (
        <RecordDialog
          key={recordForm.kind + (recordForm.expense?.expense_id ?? "")}
          d={d}
          kind={recordForm.kind}
          material={recordForm.material}
          existing={recordForm.expense}
          defaultDate={
            mode === "day" && recordForm.kind === "비용" ? value : inventoryDate
          }
          stale={stale}
          reload={reload}
          close={() => setRecordForm(undefined)}
          save={async (record) => {
            if ("expense_id" in record) {
              const expense = record as Expense;
              await commit(
                {
                  ...d,
                  expenses: recordForm.expense
                    ? replaceRecord(
                        d.expenses,
                        "expense_id",
                        recordForm.expense.expense_id,
                        expense,
                      )
                    : [...d.expenses, expense],
                },
                [
                  expense.date,
                  ...(recordForm.expense
                    ? [
                        d.expenses.find(
                          (e) =>
                            e.expense_id === recordForm.expense?.expense_id,
                        )?.date ?? recordForm.expense.date,
                      ]
                    : []),
                ],
                "비용을 저장했습니다. 손익에 반영했습니다. 재고는 바뀌지 않습니다.",
              );
              setMode("day");
              setValue(expense.date);
            } else {
              const event = record as Dataset["inventory_events"][number];
              await commit(
                { ...d, inventory_events: [...d.inventory_events, event] },
                [event.date],
                `${recordForm.kind === "실사조정" ? "실사" : recordForm.kind} 기록을 저장했습니다. 재고에 반영했습니다. 손익 비용은 추가하지 않았습니다.`,
              );
              setInventoryDate(event.date);
            }
            setRecordForm(undefined);
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          label={
            deleting.kind === "sales"
              ? (() => {
                  const s = d.sales.find((s) => s.sale_id === deleting.id);
                  return s
                    ? `${s.date} ${d.menus.find((m) => m.menu_id === s.menu_id)?.name} ${s.channel} ${s.quantity}개`
                    : "삭제된 판매 기록입니다. 새로 읽기를 해주세요.";
                })()
              : (() => {
                  const e = d.expenses.find(
                    (e) => e.expense_id === deleting.id,
                  );
                  return e
                    ? `${e.date} ${e.category} ${money(e.amount)}`
                    : "삭제된 비용 기록입니다. 새로 읽기를 해주세요.";
                })()
          }
          id={deleting.id}
          stale={stale}
          reload={reload}
          close={() => setDeleting(undefined)}
          remove={async () => {
            const dataset =
              deleting.kind === "sales"
                ? {
                    ...d,
                    sales: replaceRecord(d.sales, "sale_id", deleting.id),
                  }
                : {
                    ...d,
                    expenses: replaceRecord(
                      d.expenses,
                      "expense_id",
                      deleting.id,
                    ),
                  };
            const date =
              deleting.kind === "sales"
                ? d.sales.find((e) => e.sale_id === deleting.id)?.date
                : d.expenses.find((e) => e.expense_id === deleting.id)?.date;
            await commit(
              dataset,
              [date ?? deleting.date],
              "선택한 기록을 삭제하고 관련 결과를 다시 계산했습니다.",
            );
            setDeleting(undefined);
          }}
        />
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <section
      className={
        "metric " +
        (positive === undefined ? "" : positive ? "positive" : "negative")
      }
    >
      <span>{label}</span>
      <strong>{value}</strong>
    </section>
  );
}
function PeriodStatus({
  d,
  from,
  to,
  review,
}: {
  d: Dataset;
  from: string;
  to: string;
  review: string[];
}) {
  const dates = useMemo(() => datesBetween(from, to), [from, to]);
  const closed = dates.filter((x) => dateStatus(d, x, review) === "마감");
  const pending = dates.filter(
    (x) => dateStatus(d, x, review).includes("참고") || review.includes(x),
  );
  const missing = dates.length - closed.length - pending.length;
  const closedSales = d.sales.filter((s) => closed.includes(s.date));
  const closedCost = sum(
    d.expenses.filter((e) => closed.includes(e.date)).map((e) => e.amount),
  );
  const pendingSales = d.sales.filter((s) => pending.includes(s.date));
  const pendingCost = sum(
    d.expenses.filter((e) => pending.includes(e.date)).map((e) => e.amount),
  );
  return (
    <div className="notice" data-testid="period-status">
      <b>
        {from === to
          ? dateStatus(d, from, review)
          : `마감 ${closed.length}일 · 미마감 입력/수정 확인 ${pending.length}일 · 미마감 기록 없음/자료 없음 ${missing}일`}
      </b>
      <span>
        아래 요약은 입력된 참고 실적을 포함합니다. 미기록 날짜를 0원 마감으로
        처리하지 않습니다.
      </span>
      <span>
        마감 범위 {closed.length ? closed[0] + "~" + closed.at(-1) : "없음"}:
        순매출 {money(totals(closedSales).net)} · 손익{" "}
        {money(totals(closedSales).profit.minus(closedCost))} / 확인 필요 입력:
        순매출 {money(totals(pendingSales).net)} · 손익{" "}
        {money(totals(pendingSales).profit.minus(pendingCost))}
      </span>
    </div>
  );
}
function datesBetween(from: string, to: string) {
  const list: string[] = [];
  if (!from || !to) return list;
  const t = new Date(from + "T00:00:00Z");
  while (t.toISOString().slice(0, 10) <= to) {
    list.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() + 1);
  }
  return list;
}
function DailyTable({
  d,
  from,
  to,
  review,
}: {
  d: Dataset;
  from: string;
  to: string;
  review: string[];
}) {
  const [sort, setSort] = useState("new");
  const [all, setAll] = useState(false);
  const days = datesBetween(from, to)
    .map((date) => ({
      date,
      ...profitAndLoss(d, date, date),
      status: dateStatus(d, date, review),
    }))
    .sort((a, b) =>
      sort === "income"
        ? b.income.cmp(a.income)
        : sort === "old"
          ? a.date.localeCompare(b.date)
          : b.date.localeCompare(a.date),
    );
  const recordedDays = days.filter(
    (x) => !x.status.includes("기록 없음") && x.status !== "자료 없음",
  );
  const visibleDays = all ? days : recordedDays.slice(0, 7);
  return (
    <section className="panel">
      <div className="section-title">
        <h2>일별 손익 실적</h2>
        <label>
          정렬
          <select
            aria-label="정렬"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="new">최신 날짜순</option>
            <option value="old">과거 날짜순</option>
            <option value="income">손익 높은 순</option>
          </select>
        </label>
      </div>
      {!all && days.length > 7 && (
        <p>
          기록이 있는 날짜 중 최대 7일을 표시합니다. 미마감 기록 없음/자료 없음{" "}
          {days.length - recordedDays.length}일은 전체 일자에서 확인하세요.
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>일자 / 상태</th>
              <th>순매출</th>
              <th>직접비</th>
              <th>기간 비용</th>
              <th>손익</th>
            </tr>
          </thead>
          <tbody>
            {visibleDays.map((x) => (
              <tr key={x.date}>
                <td>
                  {x.date}
                  <small>{x.status}</small>
                </td>
                {x.status.includes("기록 없음") || x.status === "자료 없음" ? (
                  <td colSpan={4}>미기록 (마감 0원 아님)</td>
                ) : (
                  <>
                    <td>{money(x.net)}</td>
                    <td>{money(x.direct)}</td>
                    <td>{money(x.cost)}</td>
                    <td className={x.income.lt(0) ? "negative" : "positive"}>
                      {money(x.income)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!visibleDays.length && (
          <p className="empty">
            표시할 실적 기록 없음 · 마감 상태는 위 기간 안내를 확인하세요.
          </p>
        )}
      </div>
      {days.length > 7 && (
        <button onClick={() => setAll(!all)}>
          {all ? "접기" : "전체 일자 펼쳐보기"}
        </button>
      )}
    </section>
  );
}
function SalesView({
  d,
  sales,
  edit,
  remove,
}: {
  d: Dataset;
  sales: Sale[];
  edit: (s: Sale) => void;
  remove: (s: Sale) => void;
}) {
  const t = totals(sales);
  return (
    <>
      <div className="metrics">
        <Metric label="판매수량 (개)" value={t.qty.toLocaleString()} />
        <Metric label="순매출" value={money(t.net)} />
        <Metric label="전체 결제수수료" value={money(t.fee)} />
        <Metric label="직접 공헌이익" value={money(t.profit)} />
      </div>
      <section className="panel">
        <h2>일자·메뉴·채널별 판매 {sales.length.toLocaleString()}건</h2>
        <p>
          한 행은 주문 한 건이 아닌 하루 합계입니다. 수정·삭제 시 손익과
          사용량을 다시 계산합니다.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  "날짜",
                  "메뉴",
                  "채널",
                  "수량",
                  "당시 단가",
                  "전체 할인",
                  "순매출",
                  "전체 수수료",
                  "식재료 원가",
                  "포장 원가",
                  "기록 관리",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.sale_id}>
                  <td>{s.date}</td>
                  <td>{d.menus.find((m) => m.menu_id === s.menu_id)?.name}</td>
                  <td>{s.channel}</td>
                  <td>{s.quantity}개</td>
                  <td>{money(s.unit_price)}</td>
                  <td>{money(s.discount_amount)}</td>
                  <td>{money(s.net_sales)}</td>
                  <td>{money(s.payment_fee)}</td>
                  <td>{money(D(s.unit_food_cost_snapshot).mul(s.quantity))}</td>
                  <td>
                    {money(D(s.unit_packaging_cost_snapshot).mul(s.quantity))}
                  </td>
                  <td className="row-actions">
                    <button onClick={() => edit(s)}>수정</button>
                    <button onClick={() => remove(s)}>삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!sales.length && (
            <p className="empty">선택 기간 판매 기록이 없습니다.</p>
          )}
        </div>
      </section>
    </>
  );
}
function MenuView({ d, sales }: { d: Dataset; sales: Sale[] }) {
  const [channel, setChannel] = useState("전체"),
    [category, setCategory] = useState("전체"),
    [selected, setSelected] = useState("");
  const filtered = sales.filter(
    (s) =>
      (channel === "전체" || s.channel === channel) &&
      (category === "전체" ||
        d.menus.find((m) => m.menu_id === s.menu_id)?.category === category),
  );
  const keys = [...new Set(filtered.map((s) => s.menu_id + "|" + s.channel))];
  const t = totals(filtered);
  const selectedSales = filtered.filter((s) => s.menu_id === selected);
  const rs = selectedSales.length ? recipe(d, selectedSales[0]) : [];
  useEffect(() => {
    if (!filtered.some((s) => s.menu_id === selected)) setSelected("");
  }, [channel, category, sales, selected]);
  return (
    <>
      <div className="notice">
        공헌이익은 재료·포장·수수료를 빼고 남은 금액입니다. 임차료·인건비는 기간
        손익에서 확인합니다.
      </div>
      <section className="toolbar">
        <label>
          판매채널
          <select
            aria-label="판매채널"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            {["전체", "매장", "포장"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          분류
          <select
            aria-label="분류"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {["전체", "음료", "디저트"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      </section>
      <div className="metrics">
        <Metric label="판매수량 (개)" value={String(t.qty)} />
        <Metric label="순매출" value={money(t.net)} />
        <Metric label="직접 공헌이익" value={money(t.profit)} />
        <Metric label="합계 기준 이익률" value={percent(t.profit, t.net)} />
      </div>
      <section className="panel">
        <h2>메뉴·채널별 수익성</h2>
        <p>
          판매 당시의 개당 원가를 사용합니다. 메뉴를 누르면 레시피를 읽을 수
          있습니다.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  "메뉴 / 채널",
                  "판매수량",
                  "순매출",
                  "식재료비",
                  "포장비",
                  "수수료",
                  "공헌이익",
                  "개당 평균 이익",
                  "이익률",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const [id, ch] = k.split("|"),
                  x = totals(
                    filtered.filter(
                      (s) => s.menu_id === id && s.channel === ch,
                    ),
                  );
                return (
                  <tr key={k}>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setSelected(id)}
                      >
                        {d.menus.find((m) => m.menu_id === id)?.name}
                      </button>
                      <small>{ch}</small>
                    </td>
                    <td>{x.qty}개</td>
                    <td>{money(x.net)}</td>
                    <td>{money(x.food)}</td>
                    <td>{money(x.pack)}</td>
                    <td>{money(x.fee)}</td>
                    <td className={x.profit.lt(0) ? "negative" : "positive"}>
                      {money(x.profit)}
                    </td>
                    <td>{money(x.profit.div(x.qty))}</td>
                    <td>{percent(x.profit, x.net)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!keys.length && <p className="empty">선택 조건의 판매 없음</p>}
        </div>
      </section>
      {selectedSales.length > 0 && (
        <section className="panel">
          <h2>
            {d.menus.find((m) => m.menu_id === selected)?.name} · 레시피 근거
          </h2>
          <p>
            읽기 전용 · {selectedSales[0].recipe_version} · 채널별 적용 재료.
            합계는 각 판매에 보존된 당시 원가이며 현재 단가로 바꾸지 않습니다.
          </p>
          {d.recipes
            .filter(
              (r) =>
                r.menu_id === selected &&
                r.recipe_version === selectedSales[0].recipe_version,
            )
            .map((r) => (
              <div className="detail-line" key={r.material_id}>
                <span>
                  {
                    d.materials.find((m) => m.material_id === r.material_id)
                      ?.name
                  }
                </span>
                <b>
                  {quantity(r.quantity)} {r.unit} / 개 ·{" "}
                  {r.channel_only ?? "전체 채널"}
                </b>
              </div>
            ))}
          <span hidden>{rs.length}</span>
        </section>
      )}
    </>
  );
}
function InventoryView({
  d,
  stocks,
  date,
  setDate,
  record,
}: {
  d: Dataset;
  stocks: ReturnType<typeof stock>;
  date: string;
  setDate: (v: string) => void;
  record: (kind: EventKind, material: string) => void;
}) {
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const list = stocks.filter(
    (s) =>
      (filter === "all" || s.balance === null || s.balance.lte(0)) &&
      (
        s.material.name +
        " " +
        (d.suppliers.find((x) => x.supplier_id === s.material.supplier_id)
          ?.name ?? "")
      ).includes(search),
  );
  return (
    <>
      <section className="toolbar">
        <label>
          재고 기준일
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          재료명·공급사 검색
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="예: 원두"
          />
        </label>
        <label>
          재고 상태
          <select
            aria-label="재고 상태"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">전체</option>
            <option value="need">부족·확인 필요</option>
          </select>
        </label>
      </section>
      <div className="notice">
        기준일 끝의 잔량입니다. 초기재고를 포함하고 최근 실측 이후 움직임을
        반영합니다. 양수는 향후 충분함을 보장하지 않습니다. 실사는 영업 종료
        시점의 측정입니다.
      </div>
      <section className="panel">
        <h2>
          재료 잔량 · 조회 {list.length} / {stocks.length}개
        </h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  "재료 / 공급사",
                  "단위",
                  "기준일 구매가격 / 용량",
                  "단위당 가격",
                  "계산 잔량",
                  "상태",
                  "최근 실사 / 실측 / 당시 차이",
                  "재고 기록",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((s) => {
                let p;
                try {
                  p = priceAt(d, s.material.material_id, date);
                } catch {}
                return (
                  <tr key={s.material.material_id}>
                    <td>
                      {s.material.name}
                      <small>
                        {
                          d.suppliers.find(
                            (x) => x.supplier_id === s.material.supplier_id,
                          )?.name
                        }
                      </small>
                    </td>
                    <td>{s.material.unit}</td>
                    <td>
                      {p
                        ? money(p.pack_price) +
                          " / " +
                          quantity(p.pack_quantity) +
                          " " +
                          s.material.unit
                        : "적용 가격 없음"}
                    </td>
                    <td>
                      {p
                        ? D(p.pack_price)
                            .div(p.pack_quantity)
                            .toDecimalPlaces(6)
                            .toString() +
                          "원 / " +
                          s.material.unit
                        : "계산 불가"}
                    </td>
                    <td
                      className={s.balance?.lte(0) ? "negative" : ""}
                      data-testid={"stock-" + s.material.material_id}
                    >
                      {s.balance === null
                        ? "계산 불가: " + s.error
                        : quantity(s.balance) + " " + s.material.unit}
                    </td>
                    <td>
                      {s.balance === null
                        ? "계산 불가 / 확인 필요"
                        : s.balance.lte(0)
                          ? "부족 / 확인 필요"
                          : "기록상 잔량 있음"}
                    </td>
                    <td>
                      {s.count ? (
                        <>
                          {s.count.date}
                          <small>
                            {quantity(s.count.counted_quantity!)}{" "}
                            {s.material.unit} / 차이{" "}
                            {quantity(s.count.quantity)} {s.material.unit}
                          </small>
                        </>
                      ) : (
                        "실사 없음"
                      )}
                    </td>
                    <td className="row-actions">
                      <button
                        onClick={() => record("입고", s.material.material_id)}
                      >
                        입고
                      </button>
                      <button
                        onClick={() => record("폐기", s.material.material_id)}
                      >
                        폐기
                      </button>
                      <button
                        onClick={() =>
                          record("실사조정", s.material.material_id)
                        }
                      >
                        실사
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!list.length && (
            <p className="empty">
              검색·필터 결과가 없습니다. 기록은 삭제되지 않았습니다.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
function SaleForm({
  d,
  existing,
  defaultDate,
  save,
  onClose,
  stale,
  reload,
}: {
  d: Dataset;
  existing?: Sale;
  defaultDate: string;
  save: (s: Sale) => Promise<void>;
  onClose: () => void;
  stale: boolean;
  reload: () => Promise<void>;
}) {
  const previous = existing
    ? (d.sales.find((s) => s.sale_id === existing.sale_id) ?? existing)
    : undefined;
  const [input, setInput] = useState<SaleInput>(
    existing
      ? { ...existing, quantity: String(existing.quantity) }
      : {
          date: defaultDate,
          menu_id: d.menus[0]?.menu_id ?? "",
          channel: "매장",
          quantity: "1",
          unit_price: d.menus[0]?.price ?? "",
          discount_amount: "0",
          payment_fee: "",
        },
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = useRef(JSON.stringify(input));
  const dirty = JSON.stringify(input) !== initial.current;
  const update = (key: keyof SaleInput, v: string) => {
    setError("");
    setInput((i) => ({
      ...i,
      [key]: v,
      ...(key === "menu_id"
        ? { unit_price: d.menus.find((m) => m.menu_id === v)?.price ?? "" }
        : {}),
    }));
  };
  const preview = useMemo(() => {
    try {
      return {
        sale: prepareSale(
          d,
          input,
          todayKST(),
          previous?.sale_id ?? "preview",
          previous,
        ),
        error: "",
      };
    } catch (e) {
      return { sale: null, error: errorText(e) };
    }
  }, [d, input, previous]);
  const t = preview.sale ? totals([preview.sale]) : null;
  const stockWarning = useMemo(
    () =>
      preview.sale
        ? stock(
            {
              ...d,
              sales: [
                ...d.sales.filter((s) => s.sale_id !== existing?.sale_id),
                preview.sale,
              ],
            },
            input.date,
          ).some((s) => s.balance === null || s.balance.lt(0))
        : false,
    [d, preview.sale, input.date, existing],
  );
  useEffect(() => {
    dialog.current?.showModal();
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
  const close = () => {
    if (!busy && (!dirty || window.confirm("입력 중인 판매를 버릴까요?")))
      onClose();
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    setError("");
    try {
      if (stale)
        throw Error(
          "다른 탭에서 변경했습니다. 새로 읽기 후 입력을 다시 확인하세요.",
        );
      const sale = prepareSale(
        d,
        input,
        todayKST(),
        previous?.sale_id,
        previous,
      );
      busyRef.current = true;
      setBusy(true);
      await save(sale);
    } catch (e) {
      setError(errorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="sale-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <form onSubmit={(e) => void submit(e)} noValidate>
        <div className="dialog-head">
          <div>
            <h2 id="sale-title">{existing ? "판매 수정" : "하루 판매 입력"}</h2>
            <p>한 날짜·메뉴·채널의 합계 · 입력 중</p>
          </div>
          <button type="button" onClick={close} disabled={busy}>
            닫기
          </button>
        </div>
        <div className="dialog-body">
          <label>
            판매일
            <input
              type="date"
              value={input.date}
              onChange={(e) => update("date", e.target.value)}
            />
          </label>
          <label>
            메뉴
            <select
              aria-label="메뉴"
              value={input.menu_id}
              onChange={(e) => update("menu_id", e.target.value)}
            >
              {d.menus.map((m) => (
                <option value={m.menu_id} key={m.menu_id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            판매채널
            <select
              aria-label="판매채널"
              value={input.channel}
              onChange={(e) => update("channel", e.target.value)}
            >
              <option>매장</option>
              <option>포장</option>
            </select>
          </label>
          <label>
            판매수량 (개)
            <input
              inputMode="numeric"
              value={input.quantity}
              onChange={(e) => update("quantity", e.target.value)}
            />
          </label>
          <div className="quick">
            {[5, 10, 20].map((n) => (
              <button
                type="button"
                key={n}
                onClick={() => update("quantity", String(n))}
              >
                {n}개
              </button>
            ))}
            <button
              type="button"
              aria-label="수량 1 감소"
              onClick={() =>
                update(
                  "quantity",
                  String(Math.max(1, Number(input.quantity) - 1)),
                )
              }
            >
              −1
            </button>
            <button
              type="button"
              aria-label="수량 1 증가"
              onClick={() =>
                update("quantity", String(Number(input.quantity) + 1))
              }
            >
              +1
            </button>
          </div>
          {(
            [
              ["unit_price", "실제 판매단가 (원)"],
              ["discount_amount", "전체 할인액 (원)"],
              ["payment_fee", "전체 결제수수료 (원)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                inputMode="numeric"
                value={input[key]}
                onChange={(e) => update(key, e.target.value)}
                aria-invalid={!!error}
              />
            </label>
          ))}
          <p>
            기준 판매가는 제안값입니다. 실제 단가를 확인하세요. 수수료는 전체
            금액이며, 없으면 0을 직접 입력하세요.
          </p>
          <section className="preview">
            <h3>저장 전 미리보기</h3>
            {existing && (
              <p>
                변경 전: 순매출 {money(existing.net_sales)}, 개당 식재료{" "}
                {money(existing.unit_food_cost_snapshot)}, 포장{" "}
                {money(existing.unit_packaging_cost_snapshot)}.{" "}
                {existing.date === input.date &&
                existing.menu_id === input.menu_id &&
                existing.channel === input.channel
                  ? "당시 개당 원가를 유지합니다."
                  : "변경한 날짜·메뉴·채널의 원가를 적용합니다."}
              </p>
            )}
            {existing && preview.sale && (
              <p>
                변경 후 개당 원가: 식재료{" "}
                {money(preview.sale.unit_food_cost_snapshot)}, 포장{" "}
                {money(preview.sale.unit_packaging_cost_snapshot)}, 레시피{" "}
                {preview.sale.recipe_version}
              </p>
            )}
            {t ? (
              <>
                <div className="detail-line">
                  <span>순매출</span>
                  <b>{money(t.net)}</b>
                </div>
                <div className="detail-line">
                  <span>식재료비 / 포장비</span>
                  <b>
                    {money(t.food)} / {money(t.pack)}
                  </b>
                </div>
                <div className="detail-line">
                  <span>전체 수수료</span>
                  <b>{money(t.fee)}</b>
                </div>
                <div className="detail-line">
                  <span>직접 공헌이익</span>
                  <b>{money(t.profit)}</b>
                </div>
                {(t.profit.lt(0) || stockWarning) && (
                  <p className="negative">
                    <WarningCircle />
                    손실 또는 음수/확인 필요 재고가 예상됩니다. 실제 판매라면
                    저장할 수 있습니다.
                  </p>
                )}
              </>
            ) : (
              <p>{preview.error}</p>
            )}
            <small>미리보기는 기록과 재고를 바꾸지 않습니다.</small>
          </section>
          {stale && (
            <div className="notice">
              다른 탭에서 변경했습니다. 입력값은 유지됩니다.{" "}
              <button type="button" onClick={() => void reload()}>
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
          <button type="button" onClick={close} disabled={busy}>
            취소
          </button>
          <button type="submit" className="primary" disabled={busy || stale}>
            {busy ? "저장 중…" : existing ? "수정 저장" : "판매 저장"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
