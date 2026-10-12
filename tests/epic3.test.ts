import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import ExcelJS from "exceljs";
import { zipSync, strToU8 } from "fflate";
import raw from "../data/매장운영데이터.json";
import { normalizeSample, type State } from "../src/domain/model";
import {
  createTemplate,
  inspectWorkbook,
  inspectZip,
  type ImportKind,
  UNZIP_LIMIT,
} from "../src/files/excel";
import { makeBackup, parseBackup, backupFilename } from "../src/files/backup";
import {
  CafeDB,
  loadOrSeed,
  restoreState,
  commitDataset,
} from "../src/storage/db";
const d = normalizeSample(raw);
const input = ["", "2026-09-19", "M01", "포장", 10, 5000, 2000, 1200];
const state: State = {
  dataset: d,
  initialized: true,
  revision: 7,
  savedAt: "2026-10-12T00:00:00.000Z",
  schemaVersion: 1,
  calculationVersion: 1,
  reviewRequiredDates: ["2026-09-18"],
};
async function workbook(
  kind: ImportKind,
  rows: unknown[][],
  change?: (w: ExcelJS.Workbook) => void,
) {
  const w = new ExcelJS.Workbook();
  await w.xlsx.load(await createTemplate(kind, d));
  w.getWorksheet(kind === "sales" ? "판매기록" : "비용기록")!.addRows(rows);
  change?.(w);
  return new Uint8Array((await w.xlsx.writeBuffer()) as ArrayBuffer).slice()
    .buffer;
}
it("판매·비용 양식 재읽기: 시트·허용코드·양식버전·예시 미삽입", async () => {
  for (const kind of ["sales", "expenses"] as const) {
    const bytes = await createTemplate(kind, d),
      wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    expect(wb.worksheets).toHaveLength(2);
    expect(wb.worksheets[1].rowCount).toBe(1);
    expect(wb.getWorksheet("안내")!.getCell("B1").value).toBe(1);
    const r = await inspectWorkbook(bytes, kind, d, 7);
    expect(r.added).toBe(0);
    expect(r.errors).toEqual([]);
  }
});
it("판매 원가·순매출 계산, 파일 내부 중복 제외, 입력ID 유지", async () => {
  const bytes = await workbook("sales", [
      [...input],
      ["SALE-ID", ...input.slice(1)],
    ]),
    r = await inspectWorkbook(bytes, "sales", d, 7);
  expect(r.added).toBe(1);
  expect(r.skipped).toBe(1);
  expect(r.sales[0].net_sales).toBe("48000");
  expect(r.sales[0].unit_food_cost_snapshot).toBe("496.8");
  expect(r.sales[0].unit_packaging_cost_snapshot).toBe("166.4");
  expect(r.revision).toBe(7);
  const withId = await inspectWorkbook(
    await workbook("sales", [["SALE-ID", ...input.slice(1)]]),
    "sales",
    d,
    7,
  );
  expect(withId.sales[0].sale_id).toBe("SALE-ID");
});
it("기존 판매 동일ID/무ID 제외, 다른 값은 충돌, 당시 원가 재계산 안 함", async () => {
  const s = d.sales[0],
    row = [
      s.sale_id,
      s.date,
      s.menu_id,
      s.channel,
      s.quantity,
      s.unit_price,
      s.discount_amount,
      s.payment_fee,
    ];
  const changed = { ...d, price_history: [] };
  const r = await inspectWorkbook(
    await workbook("sales", [row, ["", ...row.slice(1)]]),
    "sales",
    changed,
    7,
  );
  expect(r.skipped).toBe(2);
  expect(r.errors).toEqual([]);
  const conflict = [...row];
  conflict[4] = s.quantity + 1;
  const failed = await inspectWorkbook(
    await workbook("sales", [conflict]),
    "sales",
    d,
    7,
  );
  expect(failed.errors[0].message).toMatch(/内容|내용/);
  const collision = [...conflict];
  collision[0] = "";
  expect(
    (await inspectWorkbook(await workbook("sales", [collision]), "sales", d, 7))
      .errors[0].message,
  ).toMatch(/기존 판매/);
});
it("비용 ID 있는 동일기록 제외, ID 없는 동일비용 오류, 새ID 별도비용 허용", async () => {
  const e = d.expenses[0],
    row = [e.expense_id, e.date, e.category, e.amount];
  const r = await inspectWorkbook(
    await workbook("expenses", [
      row,
      ["", ...row.slice(1)],
      ["NEW", ...row.slice(1)],
    ]),
    "expenses",
    d,
    7,
  );
  expect(r.skipped).toBe(1);
  expect(r.errors).toHaveLength(1);
  expect(r.added).toBe(1);
  expect(r.expenses[0].expense_id).toBe("NEW");
  const dup = await inspectWorkbook(
    await workbook("expenses", [
      ["", "2026-09-19", "임차료", 10000],
      ["", "2026-09-19", "임차료", 10000],
    ]),
    "expenses",
    d,
    7,
  );
  expect(dup.errors).toHaveLength(1);
});
it.each([
  [4, ""],
  [4, 0],
  [4, "1.5"],
  [5, -1],
  [6, 99999999],
  [7, ""],
  [7, { formula: "1+1", result: 2 }],
  [7, { formula: "1+1", result: 2, shareType: "shared", ref: "H3:H4" }],
  [2, "M99"],
  [3, "배달"],
  [1, "2026-02-30"],
  [1, "2099-01-01"],
])("판매 오류 열 %s 값 검사와 실제 행 번호", async (column, value) => {
  const row = [...input] as unknown[];
  row[column as number] = value;
  const r = await inspectWorkbook(
    await workbook("sales", [[], row]),
    "sales",
    d,
    7,
  );
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0].row).toBe(3);
  expect(r.added).toBe(0);
});
it("문자·날짜형·숫자형 날짜, 1904 체계와 날짜/시각 경계", async () => {
  for (const date of ["2026-09-19", new Date("2026-09-19T00:00:00Z"), 46284]) {
    const row = [...input] as unknown[];
    row[1] = date;
    const r = await inspectWorkbook(
      await workbook("sales", [row]),
      "sales",
      d,
      7,
    );
    expect(r.errors).toEqual([]);
    expect(r.sales[0].date).toBe("2026-09-19");
  }
  const row = [...input] as unknown[];
  row[1] = 46284 - 1462;
  expect(
    (
      await inspectWorkbook(
        await workbook("sales", [row], (w) => {
          w.properties.date1904 = true;
        }),
        "sales",
        d,
        7,
      )
    ).sales[0].date,
  ).toBe("2026-09-19");
  for (const date of [60, 46284.5, new Date("2026-09-19T01:00:00Z")]) {
    row[1] = date;
    expect(
      (await inspectWorkbook(await workbook("sales", [row]), "sales", d, 7))
        .errors,
    ).toHaveLength(1);
  }
});
it("혼합 정상/오류 결과는 일부 정상 후보를 제공하되 전체 반영 불가 상태", async () => {
  const bad = [...input];
  bad[2] = "M99";
  const r = await inspectWorkbook(
    await workbook("sales", [input, bad]),
    "sales",
    d,
    7,
  );
  expect(r.added).toBe(1);
  expect(r.errors).toHaveLength(1);
  expect(d.sales).toHaveLength(6112);
});
it("다른 대상 양식·필수 열·손상·압축 크기·행 번호 한도 차단", async () => {
  await expect(
    inspectWorkbook(await createTemplate("sales", d), "expenses", d, 7),
  ).rejects.toThrow(/양식/);
  await expect(
    inspectWorkbook(
      await workbook("sales", [], (w) => {
        w.worksheets[1].getCell("B1").value = "다른 열";
      }),
      "sales",
      d,
      7,
    ),
  ).rejects.toThrow(/열/);
  expect(() => inspectZip(new Uint8Array([1, 2]).buffer)).toThrow(/손상/);
  expect(() => inspectZip(new ArrayBuffer(10 * 1024 * 1024 + 1))).toThrow(
    /10MiB/,
  );
  const giant = zipSync({
    "xl/worksheets/sheet1.xml": new Uint8Array(UNZIP_LIMIT + 1),
  });
  expect(() => inspectZip(giant.buffer as ArrayBuffer)).toThrow(/64MiB/);
  const oversizedRow = zipSync({
    "xl/worksheets/sheet1.xml": strToU8('<row r="20002"><c r="A20002"/></row>'),
  });
  expect(() => inspectZip(oversizedRow.buffer as ArrayBuffer)).toThrow(
    /행 번호/,
  );
});
it("백업 전체 내용·버전·업무 기준일·한국시간 파일명·정밀문자열 왕복", () => {
  const backup = makeBackup(state, new Date("2026-10-12T01:02:03Z")),
    restored = parseBackup(JSON.stringify(backup));
  expect(restored.dataset).toEqual(state.dataset);
  expect(restored.reviewRequiredDates).toEqual(state.reviewRequiredDates);
  expect(restored.revision).toBe(7);
  expect(backupFilename(new Date("2026-10-12T01:02:03Z"))).toBe(
    "프렙카페_백업_20261012_100203.json",
  );
});
it.each([
  "",
  "{broken",
  JSON.stringify(raw),
  JSON.stringify({ ...makeBackup(state), backupVersion: 99 }),
  JSON.stringify({ ...makeBackup(state), unexpected: true }),
])("빈/손상/원본/미지원/미지필드 백업 거부", (text) => {
  expect(() => parseBackup(text)).toThrow();
});
it("백업의 중복ID·참조·단위·순매출·누락 초기재고·미지필드·위험중첩 차단", () => {
  for (const mutate of [
    (b: ReturnType<typeof makeBackup>) =>
      b.dataset.sales.push(b.dataset.sales[0]),
    (b: ReturnType<typeof makeBackup>) => {
      b.dataset.recipes[0].material_id = "UNKNOWN";
    },
    (b: ReturnType<typeof makeBackup>) => {
      b.dataset.inventory_events[0].unit = "개";
    },
    (b: ReturnType<typeof makeBackup>) => {
      b.dataset.sales[0].net_sales = "1";
    },
    (b: ReturnType<typeof makeBackup>) => {
      b.dataset.opening_inventory = [];
    },
    (b: ReturnType<typeof makeBackup>) => {
      (b.dataset as unknown as Record<string, unknown>).unknown = [];
    },
  ]) {
    const b = structuredClone(makeBackup(state));
    mutate(b);
    expect(() => parseBackup(JSON.stringify(b))).toThrow();
  }
  expect(() => parseBackup('{"__proto__":{}}')).toThrow();
  expect(() => parseBackup("[".repeat(22) + "0" + "]".repeat(22))).toThrow(
    /중첩/,
  );
});
it("빈 유효 백업 실제 복원·재실행, 현재 변경번호 증가, 과거 탭 차단·쓰기 실패 보존·손상 상태 복구", async () => {
  const database = new CafeDB("epic3-" + crypto.randomUUID());
  try {
    const original = await loadOrSeed(database, async () => d),
      empty = parseBackup(
        JSON.stringify(
          makeBackup({
            ...state,
            dataset: { ...d, sales: [], expenses: [], inventory_events: [] },
          }),
        ),
      );
    const restored = await restoreState(original.revision, empty, database);
    expect(restored.revision).toBe(original.revision + 1);
    expect((await loadOrSeed(database)).dataset.sales).toHaveLength(0);
    await expect(
      commitDataset(original, original.dataset, [], database),
    ).rejects.toThrow(/다른 탭/);
    const before = await database.appState.get("current");
    database.appState.hook("updating", () => {
      throw Error("검사용 쓰기 실패");
    });
    await expect(
      restoreState(restored.revision, state, database),
    ).rejects.toThrow();
    expect(await database.appState.get("current")).toEqual(before);
  } finally {
    await database.delete();
  }
  const broken = new CafeDB("broken-" + crypto.randomUUID());
  try {
    await broken.appState.put({
      id: "current",
      revision: 88,
      initialized: true,
    } as State & { id: "current" });
    expect((await restoreState(88, state, broken)).revision).toBe(89);
    expect((await loadOrSeed(broken)).dataset.sales).toHaveLength(6112);
  } finally {
    await broken.delete();
  }
});
