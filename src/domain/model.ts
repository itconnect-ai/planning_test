import { z } from "zod";
import Decimal from "decimal.js";
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export { Decimal };
export function validDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const date = z.string().refine(validDate, "존재하는 날짜를 입력하세요.");
const dec = z.string().refine((s) => {
  try {
    return new Decimal(s).isFinite();
  } catch {
    return false;
  }
}, "유효한 수치가 필요합니다.");
const nonnegative = dec.refine(
  (s) => new Decimal(s).gte(0),
  "음수일 수 없습니다.",
);
const positive = dec.refine((s) => new Decimal(s).gt(0), "0보다 커야 합니다.");
const id = z.string().min(1);
const unit = z.enum(["g", "ml", "개"]);
const saleSchema = z
  .object({
    sale_id: id,
    date,
    menu_id: id,
    channel: z.enum(["매장", "포장"]),
    quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    unit_price: nonnegative,
    discount_amount: nonnegative,
    net_sales: nonnegative,
    payment_fee: nonnegative,
    recipe_version: id,
    unit_food_cost_snapshot: nonnegative,
    unit_packaging_cost_snapshot: nonnegative,
  })
  .passthrough();
export const datasetSchema = z.object({
  meta: z
    .object({ start_date: date, as_of: date, store_name: id })
    .passthrough(),
  suppliers: z.array(z.object({ supplier_id: id, name: id }).passthrough()),
  materials: z.array(
    z
      .object({
        material_id: id,
        name: id,
        unit,
        supplier_id: id,
        pack_quantity: positive,
        base_pack_price: nonnegative,
      })
      .passthrough(),
  ),
  menus: z.array(
    z
      .object({
        menu_id: id,
        name: id,
        price: nonnegative,
        category: id,
        recipe_version: id,
      })
      .passthrough(),
  ),
  recipes: z.array(
    z
      .object({
        recipe_version: id,
        menu_id: id,
        material_id: id,
        quantity: positive,
        unit,
        channel_only: z.enum(["매장", "포장"]).optional(),
      })
      .passthrough(),
  ),
  price_history: z.array(
    z
      .object({
        material_id: id,
        effective_date: date,
        pack_price: nonnegative,
        pack_quantity: positive,
      })
      .passthrough(),
  ),
  calendar: z.array(
    z
      .object({ date, is_open: z.boolean(), record_complete: z.boolean() })
      .passthrough(),
  ),
  sales: z.array(saleSchema),
  opening_inventory: z.array(
    z
      .object({ material_id: id, date, quantity: nonnegative, unit })
      .passthrough(),
  ),
  inventory_events: z.array(
    z
      .object({
        event_id: id,
        date,
        material_id: id,
        event_type: z.enum(["입고", "폐기", "실사조정"]),
        quantity: dec,
        unit,
        counted_quantity: nonnegative.optional(),
        supplier_id: id.optional(),
        unit_cost: nonnegative.optional(),
        reason: z.string().optional(),
        memo: z.string().optional(),
      })
      .passthrough(),
  ),
  expenses: z.array(
    z
      .object({ expense_id: id, date, category: id, amount: positive })
      .passthrough(),
  ),
  monthly_expense_plan: z.array(
    z
      .object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        category: id,
        amount: nonnegative,
      })
      .passthrough(),
  ),
  settings: z.record(z.string(), z.unknown()),
});
export type Dataset = z.infer<typeof datasetSchema>;
export type Sale = Dataset["sales"][number];
export const stateSchema = z.object({
  schemaVersion: z.literal(1),
  calculationVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  savedAt: z.string().datetime(),
  initialized: z.literal(true),
  reviewRequiredDates: z.array(date),
  dataset: datasetSchema,
});
export type State = z.infer<typeof stateSchema>;
export function normalizeSample(raw: unknown): Dataset {
  const numericFields = new Set([
    "pack_quantity",
    "base_pack_price",
    "price",
    "quantity",
    "pack_price",
    "unit_price",
    "discount_amount",
    "net_sales",
    "payment_fee",
    "unit_food_cost_snapshot",
    "unit_packaging_cost_snapshot",
    "counted_quantity",
    "unit_cost",
    "amount",
  ]);
  const d = JSON.parse(JSON.stringify(raw), (key, value) =>
    numericFields.has(key) && typeof value === "number" ? String(value) : value,
  );
  for (const s of d.sales) s.quantity = Number(s.quantity);
  return validateDataset(d);
}
export function validateDataset(raw: unknown): Dataset {
  const d = datasetSchema.parse(raw);
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length)
      throw Error(label + " 중복 ID/기준이 있습니다.");
  };
  unique(
    d.suppliers.map((x) => x.supplier_id),
    "공급사",
  );
  unique(
    d.materials.map((x) => x.material_id),
    "재료",
  );
  unique(
    d.menus.map((x) => x.menu_id),
    "메뉴",
  );
  unique(
    d.sales.map((x) => x.sale_id),
    "판매",
  );
  unique(
    d.sales.map((x) => [x.date, x.menu_id, x.channel].join("|")),
    "판매 일자·메뉴·채널",
  );
  unique(
    d.expenses.map((x) => x.expense_id),
    "비용",
  );
  unique(
    d.inventory_events.map((x) => x.event_id),
    "재고",
  );
  unique(
    d.calendar.map((x) => x.date),
    "영업달력",
  );
  unique(
    d.opening_inventory.map((x) => x.material_id),
    "초기재고",
  );
  unique(
    d.price_history.map((x) => x.material_id + "|" + x.effective_date),
    "가격이력",
  );
  unique(
    d.recipes.map((x) =>
      [x.menu_id, x.recipe_version, x.material_id, x.channel_only ?? ""].join(
        "|",
      ),
    ),
    "레시피",
  );
  unique(
    d.inventory_events
      .filter((x) => x.counted_quantity !== undefined)
      .map((x) => x.date + "|" + x.material_id),
    "실사",
  );
  const menus = new Set(d.menus.map((x) => x.menu_id)),
    materials = new Map(d.materials.map((x) => [x.material_id, x])),
    suppliers = new Set(d.suppliers.map((x) => x.supplier_id));
  for (const m of d.materials)
    if (!suppliers.has(m.supplier_id))
      throw Error("재료 공급사 연결 오류: " + m.material_id);
  for (const r of d.recipes)
    if (!menus.has(r.menu_id) || materials.get(r.material_id)?.unit !== r.unit)
      throw Error("레시피 연결/단위 오류: " + r.menu_id);
  for (const p of d.price_history)
    if (!materials.has(p.material_id)) throw Error("가격이력 재료 연결 오류");
  for (const e of [...d.opening_inventory, ...d.inventory_events])
    if (materials.get(e.material_id)?.unit !== e.unit)
      throw Error("재고 연결/단위 오류: " + e.material_id);
  for (const e of d.inventory_events) {
    if (e.supplier_id && !suppliers.has(e.supplier_id))
      throw Error("입고 공급사 연결 오류");
    if (
      (e.event_type === "입고" && new Decimal(e.quantity).lte(0)) ||
      (e.event_type === "폐기" && new Decimal(e.quantity).gte(0))
    )
      throw Error("재고 증감 부호 오류: " + e.event_id);
  }
  for (const s of d.sales) {
    if (
      !menus.has(s.menu_id) ||
      !d.recipes.some(
        (r) => r.menu_id === s.menu_id && r.recipe_version === s.recipe_version,
      )
    )
      throw Error("판매 레시피 연결 오류: " + s.sale_id);
    if (
      !new Decimal(s.unit_price)
        .mul(s.quantity)
        .minus(s.discount_amount)
        .eq(s.net_sales)
    )
      throw Error("순매출 불일치: " + s.sale_id);
  }
  return d;
}
export function validateState(raw: unknown): State {
  const s = stateSchema.parse(raw);
  validateDataset(s.dataset);
  return s;
}
export function todayKST() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
