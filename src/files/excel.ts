import ExcelJS from "exceljs";
import { Unzip, UnzipInflate } from "fflate";
import { type Dataset, type Sale, validDate, todayKST } from "../domain/model";
import { prepareSale, D, errorText } from "../domain/calculations";
import {
  expenseCategories,
  prepareExpense,
  type Expense,
} from "../domain/operations";
export type ImportKind = "sales" | "expenses";
export const XLSX_LIMIT = 10 * 1024 * 1024,
  ROW_LIMIT = 20000,
  CELL_LIMIT = 200000,
  UNZIP_LIMIT = 64 * 1024 * 1024;
export const columns = {
  sales: [
    "기록ID",
    "날짜",
    "메뉴ID",
    "채널",
    "수량",
    "판매단가",
    "전체 할인액",
    "전체 결제수수료",
  ],
  expenses: ["기록ID", "귀속일", "비용항목", "금액"],
};
export const sheetNames = { sales: "판매기록", expenses: "비용기록" };
export type ImportResult = {
  kind: ImportKind;
  revision: number;
  added: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  sales: Sale[];
  expenses: Expense[];
};
export async function createTemplate(
  kind: ImportKind,
  d: Dataset,
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "프렙 카페";
  const guide = wb.addWorksheet("안내");
  guide.columns = [{ width: 32 }, { width: 92 }];
  guide.addRows([
    ["양식 버전", 1],
    ["기록 종류", sheetNames[kind]],
    [
      "작성 방법",
      "새 기록의 기록ID는 공란. 기존 기록을 수정하는 용도가 아닙니다.",
    ],
    ["날짜", "YYYY-MM-DD 형식 또는 엑셀 날짜. 미래 실적은 입력하지 않습니다."],
    [
      "금액·수량",
      "원·개 정수. 할인·수수료는 행 전체 금액이며 없으면 0을 직접 입력합니다.",
    ],
    [
      "수식",
      "수식·외부 링크 대신 값을 입력하세요. 입력용 시트에 예시 실적은 넣지 않았습니다.",
    ],
    [
      "반영",
      "오류가 있으면 파일 전체가 반영되지 않습니다. 검사 후 확정합니다.",
    ],
  ]);
  if (kind === "sales") {
    guide.addRow(["메뉴ID", "이름"]);
    for (const m of d.menus) guide.addRow([m.menu_id, m.name]);
    guide.addRow(["채널", "매장 / 포장"]);
  } else {
    guide.addRow([
      "허용 비용항목",
      "귀속일에 전액 반영, 자동 월배분 없음. 재료 매입은 재고 입고에서 기록.",
    ]);
    for (const c of expenseCategories(d)) guide.addRow([c]);
  }
  const sheet = wb.addWorksheet(sheetNames[kind]);
  sheet.columns = columns[kind].map((header, i) => ({
    header,
    key: String(i),
    width: i === 0 ? 28 : 22,
  }));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: kind === "sales" ? "H1" : "D1" };
  for (const ws of wb.worksheets) {
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF924802" },
    };
    ws.getRow(1).height = 26;
  }
  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer).slice().buffer;
}
export function inspectZip(buffer: ArrayBuffer) {
  if (buffer.byteLength > XLSX_LIMIT)
    throw Error("엑셀은 10MiB 이하로 나누어 가져오세요.");
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 80 || bytes[1] !== 75)
    throw Error("손상되었거나 지원하지 않는 엑셀 파일입니다.");
  let total = 0,
    declared = 0,
    entries = 0,
    cells = 0,
    rows = 0;
  const unzip = new Unzip((file) => {
    if (++entries > 10000) throw Error("압축파일 항목이 너무 많습니다.");
    declared += file.originalSize ?? 0;
    if (declared > UNZIP_LIMIT)
      throw Error("압축 해제 크기가 64MiB를 넘습니다.");
    if (/vbaProject\.bin$/i.test(file.name))
      throw Error("매크로 파일은 지원하지 않습니다.");
    const worksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(file.name),
      decoder = new TextDecoder();
    let carry = "";
    file.ondata = (err, data, final) => {
      if (err) throw err;
      total += data.length;
      if (total > UNZIP_LIMIT)
        throw Error("압축 해제 크기가 64MiB를 넘습니다.");
      if (worksheet) {
        carry += decoder.decode(data, { stream: !final });
        const end = carry.lastIndexOf(">");
        if (end >= 0) {
          const part = carry.slice(0, end + 1);
          carry = carry.slice(end + 1);
          for (const match of part.matchAll(/<(row|c)\b([^>]*)>/g)) {
            if (match[1] === "row") {
              if (++rows > ROW_LIMIT + 20)
                throw Error("파일의 데이터 행 한도는 20,000개입니다.");
              const r = /\br="(\d+)"/.exec(match[2]);
              if (r && Number(r[1]) > ROW_LIMIT + 1)
                throw Error("행 번호 한도는 20,001입니다.");
            } else if (++cells > CELL_LIMIT)
              throw Error("파일의 셀 한도는 200,000개입니다.");
          }
        }
        if (carry.length > 100000)
          throw Error("엑셀 구조가 올바르지 않습니다.");
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024)
    unzip.push(
      bytes.subarray(offset, offset + 1024),
      offset + 1024 >= bytes.length,
    );
  if (!entries) throw Error("엑셀 문서 구조를 읽을 수 없습니다.");
}
function text(cell: ExcelJS.Cell, required = true) {
  const v = cell.value;
  if (v === null || v === undefined || v === "") {
    if (required) throw Error(`${cell.address}: 필수값이 비어 있습니다.`);
    return "";
  }
  if (typeof v !== "string" && typeof v !== "number" && !(v instanceof Date))
    throw Error(`${cell.address}: 수식·링크·오류 셀 대신 값을 입력하세요.`);
  return typeof v === "string"
    ? v.trim()
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : String(v);
}
function dateCell(cell: ExcelJS.Cell, date1904: boolean) {
  const v = cell.value;
  let s: string;
  if (v instanceof Date) {
    if (
      !Number.isFinite(v.getTime()) ||
      v.getUTCHours() ||
      v.getUTCMinutes() ||
      v.getUTCSeconds() ||
      v.getUTCMilliseconds()
    )
      throw Error(`${cell.address}: 시각 없는 실제 날짜를 입력하세요.`);
    s = v.toISOString().slice(0, 10);
  } else if (typeof v === "number") {
    if (!Number.isInteger(v) || (!date1904 && v === 60))
      throw Error(`${cell.address}: 날짜는 시각 없는 실제 날짜여야 합니다.`);
    const millis = (v + (date1904 ? 1462 : v < 60 ? 1 : 0) - 25569) * 86400000;
    if (!Number.isFinite(millis) || Math.abs(millis) > 8640000000000000)
      throw Error("잘못된 엑셀 날짜입니다.");
    s = new Date(millis).toISOString().slice(0, 10);
  } else s = text(cell);
  if (!validDate(s))
    throw Error(`${cell.address}: YYYY-MM-DD 날짜를 입력하세요.`);
  return s;
}
export async function inspectWorkbook(
  buffer: ArrayBuffer,
  kind: ImportKind,
  d: Dataset,
  revision: number,
  today = todayKST(),
): Promise<ImportResult> {
  inspectZip(buffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const guide = wb.getWorksheet("안내"),
    sheet = wb.getWorksheet(sheetNames[kind]);
  if (
    !sheet ||
    !guide ||
    guide.getCell("A1").value !== "양식 버전" ||
    Number(guide.getCell("B1").value) !== 1 ||
    guide.getCell("B2").value !== sheetNames[kind]
  )
    throw Error("선택한 기록 종류의 프로그램 양식을 사용하세요.");
  const headers = columns[kind];
  for (let c = 1; c <= headers.length; c++)
    if (text(sheet.getCell(1, c)) !== headers[c - 1])
      throw Error(`입력용 시트 ${c}열 이름/순서가 다릅니다.`);
  if (sheet.columnCount > headers.length)
    throw Error("입력용 시트에 지원하지 않는 열이 있습니다.");
  const result: ImportResult = {
    kind,
    revision,
    added: 0,
    skipped: 0,
    errors: [],
    sales: [],
    expenses: [],
  };
  const existingIds = new Map<string, Sale | Expense>(
    (kind === "sales" ? d.sales : d.expenses).map((r) => [
      kind === "sales" ? (r as Sale).sale_id : (r as Expense).expense_id,
      r,
    ]),
  );
  const signatures = new Map<string, Sale | Expense>(
    (kind === "sales" ? d.sales : d.expenses).map((r) => [
      kind === "sales"
        ? [(r as Sale).date, (r as Sale).menu_id, (r as Sale).channel].join("|")
        : [r.date, (r as Expense).category, (r as Expense).amount].join("|"),
      r,
    ]),
  );
  let nonempty = 0;
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index);
    if (
      !headers.some(
        (_, c) =>
          row.getCell(c + 1).value !== null && row.getCell(c + 1).value !== "",
      )
    )
      continue;
    if (++nonempty > ROW_LIMIT) throw Error("데이터 행 한도는 20,000개입니다.");
    try {
      const id = text(row.getCell(1), false),
        date = dateCell(row.getCell(2), Boolean(wb.properties.date1904));
      let candidate: Sale | Expense,
        key: string,
        same: (r: Sale | Expense) => boolean;
      if (kind === "sales") {
        const i = {
          date,
          menu_id: text(row.getCell(3)),
          channel: text(row.getCell(4)),
          quantity: text(row.getCell(5)),
          unit_price: text(row.getCell(6)),
          discount_amount: text(row.getCell(7)),
          payment_fee: text(row.getCell(8)),
        };
        // Existing rows compare only author-entered fields. Never recompute or replace historical snapshots.
        const reference =
          (id ? existingIds.get(id) : undefined) ??
          signatures.get([date, i.menu_id, i.channel].join("|"));
        const original = reference as Sale | undefined;
        const temp = prepareSale(
          { ...d, sales: original ? [original] : [] },
          i,
          today,
          original?.sale_id || id || "IMP-" + crypto.randomUUID(),
          original,
        );
        candidate = temp;
        key = [date, i.menu_id, i.channel].join("|");
        same = (r) => {
          const s = r as Sale;
          return (
            s.date === date &&
            s.menu_id === i.menu_id &&
            s.channel === i.channel &&
            s.quantity === temp.quantity &&
            ["unit_price", "discount_amount", "payment_fee"].every((k) =>
              D(s[k as keyof Sale] as string).eq(
                temp[k as keyof Sale] as string,
              ),
            )
          );
        };
      } else {
        const e = prepareExpense(
          { ...d, expenses: [] },
          {
            date,
            category: text(row.getCell(3)),
            amount: text(row.getCell(4)),
          },
          undefined,
          false,
          today,
        );
        candidate = {
          ...e,
          expense_id: id || e.expense_id,
          source: "엑셀 가져오기",
        };
        key = [date, e.category, e.amount].join("|");
        same = (r) =>
          r.date === date &&
          (r as Expense).category === e.category &&
          D((r as Expense).amount).eq(e.amount);
      }
      const byId = id ? existingIds.get(id) : undefined,
        byKey = signatures.get(key);
      if (byId) {
        if (!same(byId))
          throw Error(
            "같은 기록ID의 내용이 다릅니다. 기존 목록에서 수정하세요.",
          );
        result.skipped++;
        continue;
      }
      if (kind === "sales" && byKey) {
        if (!same(byKey))
          throw Error(
            "같은 날짜·메뉴·채널의 값이 다릅니다. 기존 판매를 수정하세요.",
          );
        result.skipped++;
        continue;
      }
      if (kind === "expenses" && !id && byKey)
        throw Error(
          "ID 없는 동일 비용은 별도 지출인지 식별할 수 없습니다. 기존 비용을 확인하세요.",
        );
      if (kind === "sales") result.sales.push(candidate as Sale);
      else result.expenses.push(candidate as Expense);
      const newId =
        kind === "sales"
          ? (candidate as Sale).sale_id
          : (candidate as Expense).expense_id;
      existingIds.set(newId, candidate);
      signatures.set(key, candidate);
      result.added++;
    } catch (e) {
      result.errors.push({ row: index, message: errorText(e) });
    }
  }
  return result;
}
