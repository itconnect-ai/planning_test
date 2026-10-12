import { Decimal, type Dataset, type Sale, validDate, todayKST } from "./model";
export const D = (v: Decimal.Value) => new Decimal(v);
export const sum = (v: Decimal.Value[]) =>
  v.reduce<Decimal>((a, b) => a.plus(b), D(0));
export function money(v: Decimal.Value) {
  return BigInt(D(v).toFixed(0)).toLocaleString("ko-KR") + "원";
}
export function quantity(v: Decimal.Value) {
  const n = D(v);
  if (!n.isZero() && n.abs().lt("0.001"))
    return n.gt(0) ? "0 초과 0.001 미만" : "−0.001 초과 0 미만";
  const [whole, fraction] = n.toFixed(3).split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return (
    (n.lt(0) && BigInt(whole) === 0n ? "-" : "") +
    BigInt(whole).toLocaleString("ko-KR") +
    (trimmed ? "." + trimmed : "")
  );
}
export const percent = (p: Decimal.Value, n: Decimal.Value) =>
  D(n).isZero()
    ? "계산 불가 (순매출 0)"
    : D(p).div(n).mul(100).toFixed(1) + "%";
export function period(mode: string, value: string) {
  if (mode === "day") {
    if (!validDate(value)) throw Error("조회 날짜를 확인하세요.");
    return { from: value, to: value };
  }
  if (!/^\d{4}-\d{2}$/.test(value) || !validDate(value + "-01"))
    throw Error("조회 월을 확인하세요.");
  const [y, m] = value.split("-").map(Number);
  return {
    from: value + "-01",
    to: value + "-" + new Date(Date.UTC(y, m, 0)).getUTCDate(),
  };
}
export function rowsIn<T extends { date: string }>(
  rows: T[],
  from: string,
  to: string,
) {
  return rows.filter((r) => r.date >= from && r.date <= to);
}
export function recipe(
  d: Dataset,
  s: Pick<Sale, "menu_id" | "recipe_version" | "channel">,
) {
  const rs = d.recipes.filter(
    (r) => r.menu_id === s.menu_id && r.recipe_version === s.recipe_version,
  );
  if (!rs.length) throw Error("레시피 누락: " + s.menu_id);
  return rs.filter((r) => !r.channel_only || r.channel_only === s.channel);
}
export function priceAt(d: Dataset, id: string, date: string) {
  const p = d.price_history
    .filter((p) => p.material_id === id && p.effective_date <= date)
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date))[0];
  if (!p || D(p.pack_quantity).lte(0))
    throw Error("적용 가격 누락: " + id + " / " + date);
  return p;
}
export function unitCosts(
  d: Dataset,
  menu_id: string,
  channel: Sale["channel"],
  date: string,
) {
  const m = d.menus.find((m) => m.menu_id === menu_id);
  if (!m) throw Error("메뉴를 선택하세요.");
  let food = D(0),
    pack = D(0);
  for (const r of recipe(d, {
    menu_id,
    channel,
    recipe_version: m.recipe_version,
  })) {
    const material = d.materials.find((m) => m.material_id === r.material_id);
    if (!material || material.unit !== r.unit)
      throw Error("재료 단위 불일치: " + r.material_id);
    const p = priceAt(d, r.material_id, date),
      cost = D(r.quantity).mul(p.pack_price).div(p.pack_quantity);
    if (["I10", "I11"].includes(r.material_id)) pack = pack.plus(cost);
    else food = food.plus(cost);
  }
  return { food, pack, version: m.recipe_version };
}
export function totals(sales: Sale[]) {
  const qty = sales.reduce((a, s) => a + s.quantity, 0),
    net = sum(sales.map((s) => s.net_sales)),
    food = sum(sales.map((s) => D(s.unit_food_cost_snapshot).mul(s.quantity))),
    pack = sum(
      sales.map((s) => D(s.unit_packaging_cost_snapshot).mul(s.quantity)),
    ),
    fee = sum(sales.map((s) => s.payment_fee));
  return {
    qty,
    net,
    food,
    pack,
    fee,
    direct: food.plus(pack).plus(fee),
    profit: net.minus(food).minus(pack).minus(fee),
  };
}
export function profitAndLoss(d: Dataset, from: string, to: string) {
  const t = totals(rowsIn(d.sales, from, to)),
    expenses = rowsIn(d.expenses, from, to),
    cost = sum(expenses.map((e) => e.amount));
  return { ...t, cost, income: t.profit.minus(cost), expenses };
}
export function dateStatus(d: Dataset, date: string, review: string[] = []) {
  if (review.includes(date)) return "수정 후 확인 필요";
  const c = d.calendar.find((c) => c.date === date);
  if (c?.record_complete) return "마감";
  if (
    d.sales.some((s) => s.date === date) ||
    d.expenses.some((e) => e.date === date)
  )
    return "미마감 · 입력된 참고 실적";
  return c ? "미마감 · 기록 없음" : "자료 없음";
}
export function stock(d: Dataset, date: string) {
  return d.materials.map((m) => {
    try {
      const opening = d.opening_inventory.find(
        (o) => o.material_id === m.material_id,
      );
      if (!opening || date < opening.date)
        throw Error("초기재고/해당 날짜 자료 없음");
      const count = d.inventory_events
        .filter(
          (e) =>
            e.material_id === m.material_id &&
            e.date <= date &&
            e.counted_quantity !== undefined,
        )
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const begin = count?.date ?? opening.date;
      let balance = D(count?.counted_quantity ?? opening.quantity);
      let usage = D(0),
        movement = D(0);
      for (const e of d.inventory_events) {
        if (
          e.material_id !== m.material_id ||
          e.date > date ||
          (count ? e.date <= begin : e.date < begin) ||
          e.counted_quantity !== undefined
        )
          continue;
        movement = movement.plus(e.quantity);
      }
      for (const s of d.sales) {
        if (s.date > date || (count ? s.date <= begin : s.date < begin))
          continue;
        for (const r of recipe(d, s))
          if (r.material_id === m.material_id) {
            if (r.unit !== m.unit) throw Error("레시피 단위 불일치");
            usage = usage.plus(D(r.quantity).mul(s.quantity));
          }
      }
      balance = balance.plus(movement).minus(usage);
      return { material: m, balance, count, usage, movement, error: null };
    } catch (e) {
      return {
        material: m,
        balance: null,
        count: undefined,
        usage: null,
        movement: null,
        error: errorText(e),
      };
    }
  });
}
export function errorText(e: unknown) {
  return e instanceof Error
    ? e.message
    : "처리하지 못했습니다. 다시 시도하세요.";
}
export type SaleInput = {
  date: string;
  menu_id: string;
  channel: string;
  quantity: string;
  unit_price: string;
  discount_amount: string;
  payment_fee: string;
};
export function prepareSale(
  d: Dataset,
  i: SaleInput,
  today = todayKST(),
  id = "NEW-" + crypto.randomUUID(),
  previous?: Sale,
): Sale {
  if (!validDate(i.date)) throw Error("판매일: 존재하는 날짜를 입력하세요.");
  if (i.date > today) throw Error("판매일: 미래의 실적은 입력할 수 없습니다.");
  if (!["매장", "포장"].includes(i.channel))
    throw Error("판매채널을 선택하세요.");
  const values: Record<string, string> = {};
  for (const [k, label] of [
    ["quantity", "판매수량"],
    ["unit_price", "실제 판매단가"],
    ["discount_amount", "전체 할인액"],
    ["payment_fee", "전체 결제수수료"],
  ] as const) {
    const v = i[k].replaceAll(",", "").trim();
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
      throw Error(label + ": 필수값이며 0 이상의 정수로 입력하세요.");
    values[k] = v;
  }
  const qty = Number(values.quantity);
  if (qty < 1) throw Error("판매수량: 1 이상 정수로 입력하세요.");
  const gross = D(values.unit_price).mul(qty);
  if (gross.gt(Number.MAX_SAFE_INTEGER))
    throw Error("판매 총액이 계산 범위를 초과했습니다.");
  if (D(values.discount_amount).gt(gross))
    throw Error("전체 할인액은 판매 총액을 넘을 수 없습니다.");
  if (
    d.sales.some(
      (s) =>
        s.sale_id !== previous?.sale_id &&
        s.date === i.date &&
        s.menu_id === i.menu_id &&
        s.channel === i.channel,
    )
  )
    throw Error(
      "같은 날짜·메뉴·채널 판매가 있습니다. 기존 기록 수정이 필요합니다.",
    );
  if (previous && !d.sales.some((s) => s.sale_id === previous.sale_id))
    throw Error("수정 대상이 삭제되었습니다. 새로 읽기를 해주세요.");
  const keep =
    previous &&
    previous.date === i.date &&
    previous.menu_id === i.menu_id &&
    previous.channel === i.channel;
  const c = keep
    ? {
        version: previous.recipe_version,
        food: D(previous.unit_food_cost_snapshot),
        pack: D(previous.unit_packaging_cost_snapshot),
      }
    : unitCosts(d, i.menu_id, i.channel as Sale["channel"], i.date);
  return {
    sale_id: id,
    date: i.date,
    menu_id: i.menu_id,
    channel: i.channel as Sale["channel"],
    quantity: qty,
    unit_price: values.unit_price,
    discount_amount: values.discount_amount,
    payment_fee: values.payment_fee,
    net_sales: gross.minus(values.discount_amount).toString(),
    recipe_version: c.version,
    unit_food_cost_snapshot: c.food.toString(),
    unit_packaging_cost_snapshot: c.pack.toString(),
  };
}
