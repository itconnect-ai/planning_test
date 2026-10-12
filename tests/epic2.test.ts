import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import raw from "../data/매장운영데이터.json";
import { normalizeSample, type Dataset } from "../src/domain/model";
import {
  prepareSale,
  stock,
  totals,
  profitAndLoss,
} from "../src/domain/calculations";
import {
  prepareExpense,
  prepareInventory,
  expenseCategories,
  replaceRecord,
  type InventoryInput,
} from "../src/domain/operations";
import { CafeDB, commitDataset, loadOrSeed } from "../src/storage/db";
const sample = normalizeSample(raw);
const saleInput = {
  date: "2026-09-19",
  menu_id: "M01",
  channel: "포장",
  quantity: "10",
  unit_price: "5000",
  discount_amount: "2000",
  payment_fee: "1200",
};
function isolated(): Dataset {
  return {
    ...structuredClone(sample),
    sales: [],
    expenses: [],
    inventory_events: [],
    opening_inventory: sample.opening_inventory.map((e) => ({
      ...e,
      quantity: e.material_id === "I01" ? "2450" : e.quantity,
    })),
  };
}
const input: InventoryInput = {
  date: "2026-09-19",
  material_id: "I01",
  quantity: "1000",
  supplier_id: sample.materials[0].supplier_id,
  unit_cost: "",
  reason: "기록 확인",
  memo: "",
  confirmed: true,
};
it("수량 수정은 ID와 당시 원가·버전 보존, 사용량 중복 없음, 삭제 복원", () => {
  const d = isolated(),
    s = prepareSale(d, saleInput);
  d.sales = [s];
  const altered = {
    ...d,
    price_history: d.price_history.map((p) => ({ ...p, pack_price: "999999" })),
  };
  const next = prepareSale(
    altered,
    { ...saleInput, quantity: "12" },
    "2026-10-12",
    s.sale_id,
    s,
  );
  expect(next.sale_id).toBe(s.sale_id);
  expect(next.unit_food_cost_snapshot).toBe(s.unit_food_cost_snapshot);
  expect(next.recipe_version).toBe(s.recipe_version);
  expect(totals([next]).profit.toString()).toBe("48841.6");
  const edited = {
    ...d,
    sales: replaceRecord(d.sales, "sale_id", s.sale_id, next),
  };
  expect(stock(edited, input.date)[0].balance?.toString()).toBe("2210");
  expect(
    stock(
      { ...edited, sales: replaceRecord(edited.sales, "sale_id", s.sale_id) },
      input.date,
    )[0].balance?.toString(),
  ).toBe("2450");
});
it("날짜·채널 변경은 해당 가격과 포장 원가 재계산, 충돌·삭제 대상 차단", () => {
  const d = isolated(),
    s = prepareSale(d, saleInput);
  d.sales = [s];
  const n = prepareSale(
    d,
    { ...saleInput, channel: "매장" },
    "2026-10-12",
    s.sale_id,
    s,
  );
  expect(n.unit_packaging_cost_snapshot).toBe("0");
  const other = prepareSale(d, { ...saleInput, date: "2026-09-20" });
  d.sales.push(other);
  expect(() =>
    prepareSale(
      d,
      { ...saleInput, date: other.date },
      "2026-10-12",
      s.sale_id,
      s,
    ),
  ).toThrow(/같은 날짜/);
  expect(() =>
    prepareSale({ ...d, sales: [] }, saleInput, "2026-10-12", s.sale_id, s),
  ).toThrow(/삭제/);
  const dated = {
    ...d,
    price_history: [
      ...d.price_history,
      {
        material_id: "I01",
        effective_date: "2026-09-21",
        pack_price: "50000",
        pack_quantity: "1000",
      },
    ],
  };
  expect(
    prepareSale(
      dated,
      { ...saleInput, date: "2026-09-21" },
      "2026-10-12",
      s.sale_id,
      s,
    ).unit_food_cost_snapshot,
  ).toBe("1000");
});
it("비용 8개 항목, 중복 확인, ID별 수정·삭제, 두 기간 손익·재고·월계획 보존", () => {
  const d = isolated(),
    category = expenseCategories(d)[0];
  expect(expenseCategories(d)).toHaveLength(8);
  const e = prepareExpense(d, { date: input.date, category, amount: "10000" });
  d.expenses = [e];
  expect(profitAndLoss(d, input.date, input.date).income.toString()).toBe(
    "-10000",
  );
  expect(() =>
    prepareExpense(d, { date: input.date, category, amount: "10000" }),
  ).toThrow(/별도 지출/);
  const duplicate = prepareExpense(
    d,
    { date: input.date, category, amount: "10000" },
    undefined,
    true,
  );
  d.expenses.push(duplicate);
  const edited = prepareExpense(
    d,
    { date: "2026-08-01", category, amount: "12000" },
    e,
  );
  const moved = {
    ...d,
    expenses: replaceRecord(d.expenses, "expense_id", e.expense_id, edited),
  };
  expect(profitAndLoss(moved, input.date, input.date).income.toString()).toBe(
    "-10000",
  );
  expect(
    profitAndLoss(moved, "2026-08-01", "2026-08-01").income.toString(),
  ).toBe("-12000");
  const deleted = {
    ...moved,
    expenses: replaceRecord(moved.expenses, "expense_id", e.expense_id),
  };
  expect(deleted.expenses).toEqual([duplicate]);
  expect(deleted.monthly_expense_plan).toEqual(d.monthly_expense_plan);
  expect(stock(deleted, input.date)[0].balance?.toString()).toBe("2450");
});
it.each(["", "0", "-1", "1.5", "1e3", "9007199254740992"])(
  "잘못된 비용 금액 %s 거부",
  (amount) => {
    expect(() =>
      prepareExpense(isolated(), {
        date: input.date,
        category: expenseCategories(sample)[0],
        amount,
      }),
    ).toThrow(/금액/);
  },
);
it("미래·잘못된 날짜와 없는 항목 거부", () => {
  for (const date of ["2026-02-30", "2099-01-01"])
    expect(() =>
      prepareExpense(isolated(), {
        date,
        category: expenseCategories(sample)[0],
        amount: "1",
      }),
    ).toThrow();
  expect(() =>
    prepareExpense(isolated(), {
      date: input.date,
      category: "재료 매입",
      amount: "1",
    }),
  ).toThrow(/입고/);
});
it("입고의 선택 가격·메모 저장, 폐기의 부호 한 번, 손익·원가 불변", () => {
  const d = isolated(),
    e = prepareInventory(d, "입고", {
      ...input,
      unit_cost: "24.84",
      memo: "거래명세서",
    });
  expect(e.unit_cost).toBe("24.84");
  expect(e.memo).toBe("거래명세서");
  expect(prepareInventory(d, "입고", input).unit_cost).toBeUndefined();
  const withReceipt = { ...d, inventory_events: [e] };
  expect(stock(withReceipt, input.date)[0].balance?.toString()).toBe("3450");
  const waste = prepareInventory(withReceipt, "폐기", {
    ...input,
    quantity: "3500",
  });
  expect(waste.quantity).toBe("-3500");
  const after = { ...d, inventory_events: [e, waste] };
  expect(stock(after, input.date)[0].balance?.toString()).toBe("-50");
  expect(profitAndLoss(after, input.date, input.date).income.toString()).toBe(
    "0",
  );
  expect(after.price_history).toEqual(d.price_history);
});
it.each(["0", "-1", "", "1.0001", "1e3"])(
  "잘못된 입고·폐기 수량 %s 거부",
  (quantity) => {
    for (const kind of ["입고", "폐기"] as const)
      expect(() =>
        prepareInventory(isolated(), kind, { ...input, quantity }),
      ).toThrow(/수량/);
  },
);
it("단위·공급사·가격·사유·초기재고 이전·미래 검사", () => {
  const d = isolated();
  expect(() =>
    prepareInventory(d, "입고", {
      ...input,
      material_id: "I10",
      quantity: "1.5",
    }),
  ).toThrow(/수량/);
  expect(() =>
    prepareInventory(d, "입고", { ...input, supplier_id: "none" }),
  ).toThrow(/공급사/);
  expect(() =>
    prepareInventory(d, "입고", { ...input, unit_cost: "-1" }),
  ).toThrow(/가격/);
  expect(() => prepareInventory(d, "폐기", { ...input, reason: " " })).toThrow(
    /사유/,
  );
  expect(() =>
    prepareInventory(d, "입고", { ...input, date: "2025-06-30" }),
  ).toThrow(/초기재고/);
  expect(() =>
    prepareInventory(d, "입고", { ...input, date: "2099-01-01" }),
  ).toThrow(/미래/);
});
it("실사 2450→2100 차이−350, 다음 날 입고1000−사용500=2600, 과거 판매 수정에도 실측 불변", () => {
  const d = isolated();
  const count = prepareInventory(d, "실사조정", { ...input, quantity: "2100" });
  expect(count.quantity).toBe("-350");
  d.inventory_events = [count];
  expect(stock(d, input.date)[0].balance?.toString()).toBe("2100");
  d.inventory_events.push(
    prepareInventory(d, "입고", { ...input, date: "2026-09-20" }),
  );
  d.sales = [
    prepareSale(d, { ...saleInput, date: "2026-09-20", quantity: "25" }),
  ];
  expect(stock(d, "2026-09-20")[0].balance?.toString()).toBe("2600");
  d.sales.push(
    prepareSale(d, { ...saleInput, date: "2026-09-18", quantity: "20" }),
  );
  const prior = d.sales.at(-1)!;
  const corrected = prepareSale(d, {...saleInput,date:'2026-09-18',quantity:'30'},'2026-10-12',prior.sale_id,prior);
  d.sales = replaceRecord(d.sales,'sale_id',prior.sale_id,corrected);
  expect(stock(d, input.date)[0].balance?.toString()).toBe("2100");
  expect(stock(d, "2026-09-20")[0].balance?.toString()).toBe("2600");
  expect(() =>
    prepareInventory(d, "실사조정", { ...input, quantity: "2200" }),
  ).toThrow(/이미/);
});
it("실사 0 허용, 확인란·음수·사유·누락 재고 차단", () => {
  const d = isolated();
  expect(
    prepareInventory(d, "실사조정", { ...input, quantity: "0" })
      .counted_quantity,
  ).toBe("0");
  expect(() =>
    prepareInventory(d, "실사조정", { ...input, confirmed: false }),
  ).toThrow(/확인/);
  expect(() =>
    prepareInventory(d, "실사조정", { ...input, quantity: "-1" }),
  ).toThrow(/수량/);
  expect(() =>
    prepareInventory(d, "실사조정", { ...input, reason: "" }),
  ).toThrow(/사유/);
  expect(() =>
    prepareInventory({ ...d, opening_inventory: [] }, "실사조정", input),
  ).toThrow();
});
it("모든 변경의 실제 저장·재실행, 마감일 이동 양쪽 확인 필요, 오래된 변경 차단", async () => {
  const db = new CafeDB("epic2-" + crypto.randomUUID());
  try {
    let state = await loadOrSeed(db, async () => isolated());
    const closed = state.dataset.calendar
      .filter((c) => c.record_complete)
      .slice(0, 2)
      .map((c) => c.date);
    const expense = prepareExpense(state.dataset, {
      date: closed[0],
      category: expenseCategories(sample)[0],
      amount: "10000",
    });
    state = await commitDataset(
      state,
      { ...state.dataset, expenses: [expense] },
      [expense.date],
      db,
    );
    const old = state;
    const moved = prepareExpense(
      state.dataset,
      { date: closed[1], category: expense.category, amount: "10000" },
      expense,
    );
    state = await commitDataset(
      state,
      { ...state.dataset, expenses: [moved] },
      closed,
      db,
    );
    expect(state.reviewRequiredDates).toEqual(expect.arrayContaining(closed));
    await expect(commitDataset(old, old.dataset, [], db)).rejects.toThrow(
      /다른 탭/,
    );
    const receipt = prepareInventory(state.dataset, "입고", input);
    state = await commitDataset(
      state,
      { ...state.dataset, inventory_events: [receipt] },
      [input.date],
      db,
    );
    expect((await loadOrSeed(db)).dataset.inventory_events[0].quantity).toBe(
      "1000",
    );
    const before = await db.appState.get("current");
    db.appState.hook("updating", () => {
      throw Error("저장 실패");
    });
    await expect(
      commitDataset(
        state,
        { ...state.dataset, expenses: [] },
        [moved.date],
        db,
      ),
    ).rejects.toThrow(/실패/);
    expect(await db.appState.get("current")).toEqual(before);
  } finally {
    await db.delete();
  }
});
