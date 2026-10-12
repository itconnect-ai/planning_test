import { describe, it, expect } from "vitest";
import raw from "../data/매장운영데이터.json";
import {
  normalizeSample,
  validateDataset,
  validDate,
} from "../src/domain/model";
import {
  D,
  money,
  percent,
  prepareSale,
  stock,
  totals,
  profitAndLoss,
  unitCosts,
  dateStatus,
  quantity,
  period,
} from "../src/domain/calculations";
const sample = normalizeSample(raw);
const isolated = (): typeof sample => ({
  ...structuredClone(sample),
  sales: [],
  expenses: [],
  inventory_events: [],
  monthly_expense_plan: [],
});
const input = {
  date: "2026-09-19",
  menu_id: "M01",
  channel: "포장",
  quantity: "10",
  unit_price: "5000",
  discount_amount: "2000",
  payment_fee: "1200",
};
it("소수 음수 재고 부호와 큰 합계 표시 정밀도를 유지", () => {
  expect(quantity("-0.5")).toBe("-0.5");
  expect(quantity("-0.001")).toBe("-0.001");
  expect(money("9007199254740993")).toBe("9,007,199,254,740,993원");
});
describe("S01 샘플·참조 검사", () => {
  it("원본의 정확한 기록 개수와 ID 보존", () => {
    expect(sample.sales).toHaveLength(6112);
    expect(sample.materials).toHaveLength(11);
    expect(sample.menus).toHaveLength(8);
    expect(sample.expenses).toHaveLength(3560);
    expect(sample.inventory_events).toHaveLength(1515);
    expect(sample.sales[0].sale_id).toBe("S000001");
  });
  it("중복 ID·판매키·깨진 연결·순매출 불일치는 거부", () => {
    for (const mutate of [
      (d: typeof sample) => d.sales.push(d.sales[0]),
      (d: typeof sample) => {
        d.sales[0].menu_id = "BAD";
      },
      (d: typeof sample) => {
        d.recipes[0].unit = "ml";
      },
      (d: typeof sample) => {
        d.sales[0].net_sales = "1";
      },
    ]) {
      const d = structuredClone(sample);
      mutate(d);
      expect(() => validateDataset(d)).toThrow();
    }
  });
  it("존재하지 않는 날짜 검사", () => {
    expect(validDate("2026-02-29")).toBe(false);
    expect(validDate("2024-02-29")).toBe(true);
    expect(() => period("month", "2026-13")).toThrow();
    expect(period("month", "2026-09").to).toBe("2026-09-30");
  });
});
describe("S02·S03 판매·원가·수익성", () => {
  it("5천원 10개 할인2천 수수료1200 → 순매출48000, 적용일 원가·포장비", () => {
    const s = prepareSale(sample, input, "2026-10-12", "test");
    expect(s.net_sales).toBe("48000");
    const p = sample.price_history
      .filter((p) => p.material_id === "I01" && p.effective_date <= input.date)
      .at(-1)!;
    expect(
      D(s.unit_food_cost_snapshot).eq(
        D(p.pack_price).div(p.pack_quantity).mul(20),
      ),
    ).toBe(true);
    expect(D(s.unit_packaging_cost_snapshot).gt(0)).toBe(true);
    expect(totals([s]).fee.toString()).toBe("1200");
    expect(
      totals([s]).profit.eq(
        D(48000)
          .minus(D(s.unit_food_cost_snapshot).mul(10))
          .minus(D(s.unit_packaging_cost_snapshot).mul(10))
          .minus(1200),
      ),
    ).toBe(true);
  });
  it("C03 독립 예시 35800원·74.6% 및 소수 원가·반올림", () => {
    const s = {
      ...prepareSale(sample, input, "2026-10-12", "test"),
      unit_food_cost_snapshot: "1000",
      unit_packaging_cost_snapshot: "100",
    };
    const t = totals([s]);
    expect(t.profit.toString()).toBe("35800");
    expect(percent(t.profit, t.net)).toBe("74.6%");
    expect(money("-1.5")).toBe("-2원");
    expect(quantity("0.0001")).toBe("0 초과 0.001 미만");
  });
  it("과거 snapshot 보존, 채널별 포장비, 단가 적용일", () => {
    const d = structuredClone(sample);
    const before = totals(d.sales).profit.toString();
    d.price_history[0].pack_price = "999999";
    expect(totals(d.sales).profit.toString()).toBe(before);
    expect(unitCosts(sample, "M01", "매장", "2025-07-01").food.toString()).toBe(
      "460",
    );
    expect(unitCosts(sample, "M01", "매장", input.date).pack.toString()).toBe(
      "0",
    );
    expect(unitCosts(sample, "M01", "포장", input.date).pack.gt(0)).toBe(true);
    expect(() => unitCosts(sample, "M01", "포장", "2025-06-01")).toThrow(
      /가격/,
    );
  });
  it("가중 합계 비율, 무료판매 이익률 계산불가, 음수 이익 유지", () => {
    const a = prepareSale(
      sample,
      { ...input, unit_price: "0", discount_amount: "0" },
      "2026-10-12",
      "a",
    );
    expect(totals([a]).profit.lt(0)).toBe(true);
    expect(percent(totals([a]).profit, 0)).toContain("계산 불가");
    const b = {
      ...a,
      sale_id: "b",
      net_sales: "1000",
      unit_food_cost_snapshot: "0",
      unit_packaging_cost_snapshot: "0",
      payment_fee: "0",
    };
    const t = totals([a, b]);
    expect(percent(t.profit, t.net)).toBe(
      t.profit.div(1000).mul(100).toFixed(1) + "%",
    );
  });
  it.each([
    { payment_fee: "" },
    { quantity: "0" },
    { quantity: "1.5" },
    { quantity: "-1" },
    { unit_price: "NaN" },
    { discount_amount: "50001" },
    { date: "2026-02-30" },
    { date: "2027-01-01" },
    { quantity: "9007199254740992" },
    { menu_id: "BAD" },
  ])("잘못된 필수값 거부 %j", (patch) => {
    expect(() =>
      prepareSale(sample, { ...input, ...patch }, "2026-10-12"),
    ).toThrow();
  });
  it("명시적 수수료0 허용, 중복 일자메뉴채널 거부", () => {
    expect(
      prepareSale(sample, { ...input, payment_fee: "0" }, "2026-10-12")
        .payment_fee,
    ).toBe("0");
    const s = sample.sales[0];
    expect(() =>
      prepareSale(
        sample,
        { ...input, date: s.date, menu_id: s.menu_id, channel: s.channel },
        "2026-10-12",
      ),
    ).toThrow(/같은 날짜/);
  });
});
describe("S04 기간 손익·마감 상태", () => {
  it("C04 백만원−직접비30만원−기간비40만원=30만원; 월계획·입고 제외", () => {
    const d = isolated();
    d.sales = [
      {
        ...prepareSale(sample, input, "2026-10-12", "a"),
        quantity: 1,
        net_sales: "1000000",
        unit_food_cost_snapshot: "200000",
        unit_packaging_cost_snapshot: "50000",
        payment_fee: "50000",
      },
    ];
    d.expenses = [
      {
        expense_id: "X",
        date: input.date,
        category: "임차료",
        amount: "400000",
      },
    ];
    d.monthly_expense_plan = [
      { month: "2026-09", category: "임차료", amount: "400000" },
    ];
    d.inventory_events = [
      {
        event_id: "E",
        date: input.date,
        material_id: "I01",
        event_type: "입고",
        quantity: "10000",
        unit: "g",
        unit_cost: "9999",
      },
    ];
    expect(profitAndLoss(d, input.date, input.date).income.toString()).toBe(
      "300000",
    );
  });
  it("비용만 있는 날·마감 무판매·미마감·자료없음 구별", () => {
    const d = isolated();
    d.expenses = [
      {
        expense_id: "X",
        date: "2026-09-19",
        category: "임차료",
        amount: "10000",
      },
    ];
    expect(profitAndLoss(d, "2026-09-19", "2026-09-19").income.toString()).toBe(
      "-10000",
    );
    expect(dateStatus(d, "2026-09-18")).toBe("마감");
    expect(dateStatus(d, "2026-09-19")).toContain("참고");
    expect(dateStatus(d, "2026-09-20")).toContain("기록 없음");
    expect(dateStatus(d, "2026-10-01")).toBe("자료 없음");
    expect(dateStatus(d, "2026-09-18", ["2026-09-18"])).toBe(
      "수정 후 확인 필요",
    );
  });
});
describe("S05 재고·실사", () => {
  it("C05 초기6000+입고1000−폐기100−판매2000=4900", () => {
    const d = isolated();
    d.inventory_events = [
      {
        event_id: "e1",
        date: "2025-07-01",
        material_id: "I01",
        event_type: "입고",
        quantity: "1000",
        unit: "g",
      },
      {
        event_id: "e2",
        date: "2025-07-01",
        material_id: "I01",
        event_type: "폐기",
        quantity: "-100",
        unit: "g",
      },
    ];
    d.sales = [
      prepareSale(
        d,
        { ...input, date: "2025-07-01", quantity: "100" },
        "2026-10-12",
        "a",
      ),
    ];
    expect(stock(d, "2025-07-01")[0].balance?.toString()).toBe("4900");
  });
  it("실측2100+다음날입고1000−판매500=2600; 실사당일 조정·판매 재차 차감 안 함", () => {
    const d = isolated();
    d.inventory_events = [
      {
        event_id: "count",
        date: "2025-07-25",
        material_id: "I01",
        event_type: "실사조정",
        quantity: "-350",
        unit: "g",
        counted_quantity: "2100",
      },
      {
        event_id: "in",
        date: "2025-07-26",
        material_id: "I01",
        event_type: "입고",
        quantity: "1000",
        unit: "g",
      },
    ];
    d.sales = [
      prepareSale(
        d,
        { ...input, date: "2025-07-25", quantity: "100" },
        "2026-10-12",
        "a",
      ),
      prepareSale(
        d,
        { ...input, date: "2025-07-26", quantity: "25" },
        "2026-10-12",
        "b",
      ),
    ];
    expect(stock(d, "2025-07-25")[0].balance?.toString()).toBe("2100");
    expect(stock(d, "2025-07-26")[0].balance?.toString()).toBe("2600");
    d.sales[0].quantity = 1000;
    expect(stock(d, "2025-07-26")[0].balance?.toString()).toBe("2600");
    expect(stock(d, "2025-07-24")[0].count).toBeUndefined();
  });
  it("포장10개 → 원두200g·컵10개, 기준일 이후 판매 제외", () => {
    const before = stock(sample, "2026-09-19");
    const s = prepareSale(sample, input, "2026-10-12", "a");
    const d = { ...sample, sales: [...sample.sales, s] };
    const after = stock(d, "2026-09-19");
    expect(before[0].balance!.minus(after[0].balance!).toString()).toBe("200");
    expect(before[9].balance!.minus(after[9].balance!).toString()).toBe("10");
    expect(stock(d, "2026-09-18")[0].balance?.toString()).toBe(
      stock(sample, "2026-09-18")[0].balance?.toString(),
    );
  });
  it("필수 초기재고 누락은0이 아닌 계산불가, 음수 보존", () => {
    const d = isolated();
    d.opening_inventory = d.opening_inventory.filter(
      (x) => x.material_id !== "I01",
    );
    expect(stock(d, input.date)[0].balance).toBeNull();
    const e = isolated();
    e.sales = [
      prepareSale(e, { ...input, quantity: "999999" }, "2026-10-12", "a"),
    ];
    expect(stock(e, input.date)[0].balance!.lt(0)).toBe(true);
  });
});
