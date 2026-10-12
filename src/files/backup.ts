import { z } from "zod";
import {
  type State,
  type Dataset,
  validateState,
  validDate,
} from "../domain/model";
import { profitAndLoss, stock } from "../domain/calculations";
export const BACKUP_FORMAT = "prep-cafe-backup";
const envelope = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    backupVersion: z.literal(1),
    schemaVersion: z.literal(1),
    calculationVersion: z.literal(1),
    appVersion: z.string(),
    exportedAt: z.string().datetime(),
    sourceRevision: z.number().int().nonnegative(),
    recordBasis: z
      .object({
        startDate: z.string().refine(validDate),
        asOf: z.string().refine(validDate),
        description: z.string(),
      })
      .strict(),
    dataset: z.unknown(),
    reviewRequiredDates: z.array(z.string().refine(validDate)),
  })
  .strict();
export function safeJson(text: string): unknown {
  if (!text.trim())
    throw Error("빈 파일입니다. 프로그램에서 내려받은 백업을 선택하세요.");
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw Error("파일 내용이 손상되었습니다. 정상 백업 파일을 선택하세요.");
  }
  const pending: Array<[unknown, number]> = [[root, 0]];
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (depth > 20) throw Error("중첩이 너무 깊은 파일입니다.");
    if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw Error("지원하지 않는 필드입니다.");
        pending.push([item, depth + 1]);
      }
  }
  return root;
}
const allowed: Record<keyof Dataset, string[]> = {
  meta: [
    "store_name",
    "currency",
    "amount_basis",
    "data_class",
    "dataset_id",
    "seed",
    "source",
    "version",
    "start_date",
    "as_of",
  ],
  suppliers: ["supplier_id", "name", "data_class"],
  materials: [
    "material_id",
    "name",
    "unit",
    "supplier_id",
    "pack_quantity",
    "base_pack_price",
    "lead_days",
    "safety_days",
  ],
  menus: ["menu_id", "name", "category", "price", "recipe_version"],
  recipes: [
    "recipe_version",
    "menu_id",
    "material_id",
    "quantity",
    "unit",
    "channel_only",
  ],
  price_history: [
    "material_id",
    "effective_date",
    "pack_price",
    "pack_quantity",
  ],
  calendar: ["date", "is_open", "record_complete", "weather", "memo", "note"],
  sales: [
    "sale_id",
    "date",
    "menu_id",
    "channel",
    "quantity",
    "unit_price",
    "discount_amount",
    "net_sales",
    "payment_fee",
    "recipe_version",
    "unit_food_cost_snapshot",
    "unit_packaging_cost_snapshot",
  ],
  opening_inventory: ["material_id", "date", "quantity", "unit"],
  inventory_events: [
    "event_id",
    "date",
    "material_id",
    "event_type",
    "quantity",
    "unit",
    "counted_quantity",
    "supplier_id",
    "reason",
    "unit_cost",
    "memo",
  ],
  expenses: [
    "expense_id",
    "date",
    "category",
    "amount",
    "source",
    "memo",
    "recognition",
  ],
  monthly_expense_plan: ["month", "category", "amount"],
  settings: [],
};
// The original sample's descriptive fields are included explicitly, never executed or merged into globals.
export function checkBackupFields(d: Dataset) {
  for (const key of Object.keys(d))
    if (!(key in allowed)) throw Error("알 수 없는 자료 묶음: " + key);
  for (const [key, fields] of Object.entries(allowed)) {
    const section = d[key as keyof Dataset];
    const rows = Array.isArray(section) ? section : [section];
    for (const row of rows)
      for (const field of Object.keys(row)) {
        if (!fields.includes(field))
          throw Error(`알 수 없는 백업 필드: ${key}.${field}`);
        const value = (row as Record<string, unknown>)[field];
        if (value !== null && typeof value === "object")
          throw Error(`지원하지 않는 중첩 필드: ${key}.${field}`);
      }
  }
}
export function makeBackup(state: State, now = new Date()) {
  const s = validateState(state);
  checkBackupFields(s.dataset);
  return {
    format: BACKUP_FORMAT,
    backupVersion: 1,
    schemaVersion: s.schemaVersion,
    calculationVersion: s.calculationVersion,
    appVersion: "0.1.0",
    exportedAt: now.toISOString(),
    sourceRevision: s.revision,
    recordBasis: {
      startDate: s.dataset.meta.start_date,
      asOf: s.dataset.meta.as_of,
      description:
        "업무 기준일과 파일 생성시각은 다릅니다. 미확정 입력은 포함하지 않습니다.",
    },
    dataset: s.dataset,
    reviewRequiredDates: s.reviewRequiredDates,
  };
}
export function parseBackup(text: string): State {
  const raw = safeJson(text);
  if (!raw || typeof raw !== "object" || !("format" in raw))
    throw Error(
      "원본 샘플 JSON은 백업이 아닙니다. 프로그램에서 내려받은 백업을 선택하세요.",
    );
  const checked = envelope.safeParse(raw);
  if (!checked.success)
    throw Error(
      "백업 형식·버전 또는 필수 정보가 맞지 않습니다. 이 프로그램에서 만든 호환되는 백업을 선택하세요.",
    );
  const b = checked.data;
  checkBackupFields(b.dataset as Dataset);
  const state = validateState({
    schemaVersion: b.schemaVersion,
    calculationVersion: b.calculationVersion,
    revision: b.sourceRevision,
    savedAt: b.exportedAt,
    initialized: true,
    dataset: b.dataset,
    reviewRequiredDates: b.reviewRequiredDates,
  });
  checkBackupFields(state.dataset);
  if (
    b.recordBasis.startDate !== state.dataset.meta.start_date ||
    b.recordBasis.asOf !== state.dataset.meta.as_of
  )
    throw Error("업무 기준일이 자료정보와 다릅니다.");
  const stockRows = stock(state.dataset, state.dataset.meta.as_of);
  if (stockRows.some((s) => s.balance === null))
    throw Error("재고 계산에 필요한 기준 자료가 누락되었습니다.");
  profitAndLoss(
    state.dataset,
    state.dataset.meta.start_date,
    state.dataset.meta.as_of,
  );
  return state;
}
export function backupFilename(now = new Date()) {
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(now)
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(" ", "_");
  return `프렙카페_백업_${stamp}.json`;
}
