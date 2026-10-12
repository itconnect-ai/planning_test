import { type Dataset, validDate, todayKST } from "./model";
import { D, stock } from "./calculations";
export type Expense = Dataset["expenses"][number];
export type InventoryEvent = Dataset["inventory_events"][number];
export type EventKind = "입고" | "폐기" | "실사조정";
export function actualDate(date: string, today = todayKST()) {
  if (!validDate(date)) throw Error("존재하는 날짜를 입력하세요.");
  if (date > today) throw Error("미래의 실적은 입력할 수 없습니다.");
}
export function expenseCategories(_d: Dataset) {
  return [
    "임차료",
    "인건비",
    "사업주 부담 보험료",
    "관리비",
    "수도광열비",
    "통신·소프트웨어",
    "광고비",
    "소모품·청소비",
  ];
}
export function prepareExpense(
  d: Dataset,
  input: { date: string; category: string; amount: string },
  previous?: Expense,
  confirmed = false,
  today = todayKST(),
): Expense {
  actualDate(input.date, today);
  if (previous && !d.expenses.some((e) => e.expense_id === previous.expense_id))
    throw Error("수정 대상이 삭제되었습니다. 새로 읽기를 해주세요.");
  if (!expenseCategories(d).includes(input.category))
    throw Error("기존 비용항목을 선택하세요. 재료 매입은 입고에서 기록하세요.");
  const amount = input.amount.replaceAll(",", "").trim();
  if (
    !/^\d+$/.test(amount) ||
    !Number.isSafeInteger(Number(amount)) ||
    D(amount).lte(0)
  )
    throw Error("비용 금액은 1원 이상의 정수로 입력하세요.");
  if (
    !confirmed &&
    d.expenses.some(
      (e) =>
        e.expense_id !== previous?.expense_id &&
        e.date === input.date &&
        e.category === input.category &&
        D(e.amount).eq(amount),
    )
  )
    throw Error(
      "같은 날짜·항목·금액이 있습니다. 별도 지출인지 확인란을 선택하세요.",
    );
  return {
    ...previous,
    expense_id: previous?.expense_id ?? "EXP-" + crypto.randomUUID(),
    date: input.date,
    category: input.category,
    amount: D(amount).toString(),
    source: "직접 입력",
  };
}
export type InventoryInput = {
  date: string;
  material_id: string;
  quantity: string;
  supplier_id: string;
  unit_cost: string;
  reason: string;
  memo: string;
  confirmed: boolean;
};
export function prepareInventory(
  d: Dataset,
  kind: EventKind,
  input: InventoryInput,
  today = todayKST(),
): InventoryEvent {
  actualDate(input.date, today);
  const m = d.materials.find((m) => m.material_id === input.material_id);
  if (!m) throw Error("재료를 선택하세요.");
  const opening = d.opening_inventory.find(
    (e) => e.material_id === m.material_id,
  );
  if (!opening || input.date < opening.date)
    throw Error("초기재고 이후 날짜에 기록하세요.");
  const value = input.quantity.replaceAll(",", "").trim();
  const pattern = m.unit === "개" ? /^\d+$/ : /^\d+(\.\d{1,3})?$/;
  if (
    !pattern.test(value) ||
    D(value).gt(Number.MAX_SAFE_INTEGER) ||
    (kind === "실사조정" ? D(value).lt(0) : D(value).lte(0))
  )
    throw Error(
      "수량을 기준단위로 입력하세요. 개는 정수, g·ml는 소수 3자리까지이며 입고·폐기는 0보다 커야 합니다.",
    );
  const event: InventoryEvent = {
    event_id: "INV-" + crypto.randomUUID(),
    date: input.date,
    material_id: m.material_id,
    event_type: kind,
    quantity: D(value).toString(),
    unit: m.unit,
  };
  if (kind === "입고") {
    if (!d.suppliers.some((s) => s.supplier_id === input.supplier_id))
      throw Error("공급사를 선택하세요.");
    event.supplier_id = input.supplier_id;
    event.memo = input.memo.trim();
    if (input.unit_cost.trim()) {
      if (
        !/^\d+(\.\d+)?$/.test(input.unit_cost.trim()) ||
        !D(input.unit_cost).isFinite() ||
        D(input.unit_cost).gt(Number.MAX_SAFE_INTEGER)
      )
        throw Error("입고 단위당 가격은 0 이상의 숫자로 입력하세요.");
      event.unit_cost = D(input.unit_cost).toString();
    }
  } else {
    if (!input.reason.trim()) throw Error("사유를 입력하세요.");
    event.reason = input.reason.trim();
    if (kind === "폐기") event.quantity = D(value).negated().toString();
    else {
      if (
        d.inventory_events.some(
          (e) =>
            e.material_id === m.material_id &&
            e.date === input.date &&
            e.counted_quantity !== undefined,
        )
      )
        throw Error(
          "같은 재료·날짜의 실사가 이미 있습니다. 중복 저장할 수 없습니다.",
        );
      if (!input.confirmed)
        throw Error(
          "영업 종료 시점의 실측량이며 이후 날짜 결과가 바뀔 수 있음을 확인하세요.",
        );
      const before = stock(d, input.date).find(
        (s) => s.material.material_id === m.material_id,
      );
      if (!before || before.balance === null)
        throw Error(
          "실사 전 잔량을 계산할 수 없습니다. 기준 자료를 확인하세요.",
        );
      event.quantity = D(value).minus(before.balance).toString();
      event.counted_quantity = D(value).toString();
    }
  }
  return event;
}
export function replaceRecord<T>(
  rows: T[],
  key: keyof T,
  id: unknown,
  next?: T,
) {
  if (!rows.some((r) => r[key] === id))
    throw Error("대상이 삭제되었습니다. 새로 읽기를 해주세요.");
  return rows.flatMap((r) => (r[key] === id ? (next ? [next] : []) : [r]));
}
