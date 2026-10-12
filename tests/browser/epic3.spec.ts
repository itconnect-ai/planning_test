import { test, expect, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { createTemplate } from "../../src/files/excel";
import { normalizeSample, type State } from "../../src/domain/model";
import raw from "../../data/매장운영데이터.json" with { type: "json" };
const d = normalizeSample(raw),
  sale = ["", "2026-09-19", "M01", "포장", 10, 5000, 2000, 1200];
async function read(page: Page): Promise<State> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("prep-cafe");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("appState"),
            q = tx.objectStore("appState").get("current");
          q.onsuccess = () => resolve(q.result);
          q.onerror = () => reject(q.error);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}
async function start(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  await data(page);
}
async function data(page: Page) {
  await page
    .getByRole("link", { name: "백업 및 데이터 관리", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "엑셀 양식·가져오기" }),
  ).toBeVisible();
}
async function fixture(kind: "sales" | "expenses", rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await createTemplate(kind, d));
  wb.worksheets[1].addRows(rows);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
async function upload(page: Page, buffer: Buffer, name = "판매.xlsx") {
  await page.getByLabel("엑셀 파일", { exact: true }).setInputFiles({
    name,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
  });
  await expect(
    page.getByRole("heading", { name: "가져오기 검사 결과" }),
  ).toBeVisible();
}
async function backup(page: Page) {
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "전체 백업 내려받기", exact: true })
    .click();
  const result = await downloaded;
  const file = await result.path();
  expect(result.suggestedFilename()).toMatch(
    /^프렙카페_백업_\d{8}_\d{6}\.json$/,
  );
  return file!;
}
async function restoreFile(page: Page, path: string) {
  await page.getByLabel("백업 복원 파일", { exact: true }).setInputFiles({
    name: "실제_내려받은_백업.json",
    mimeType: "application/json",
    buffer: await readFile(path),
  });
  await expect(
    page.getByRole("heading", { name: "복원 전 확인" }),
  ).toBeVisible();
}
async function confirmRestore(page: Page) {
  await page
    .getByRole("checkbox", {
      name: "현재 기록 전체가 교체되며 기존 입력은 폐기됨을 확인했습니다",
    })
    .check();
  await page
    .getByRole("button", { name: "전체 교체 복원", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("복원을 완료");
}
test("S11 실제 양식 다운로드→작성→검사→확정→수익/손익/재고→재실행·반복 제외", async ({
  page,
}) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:5173") &&
      !r.url().startsWith("blob:") &&
      !r.url().startsWith("data:")
    )
      external.push(r.url());
  });
  await start(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "양식 내려받기", exact: true })
    .click();
  const template = await download;
  expect(template.suggestedFilename()).toBe("판매기록_입력양식.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile((await template.path())!);
  expect(wb.worksheets[1].rowCount).toBe(1);
  wb.worksheets[1].addRow(sale);
  const file = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  await upload(page, file);
  await expect(
    page.getByText("새 기록 1건 · 중복 제외 0건 · 오류 0건"),
  ).toBeVisible();
  expect((await read(page)).dataset.sales).toHaveLength(6112);
  await page.screenshot({
    path: "docs/evidence/epic3-import-preview.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "가져오기 확정", exact: true })
    .dblclick();
  await expect(page.getByTestId("sale-count")).toHaveText("6,113");
  await page.getByRole("link", { name: "메뉴 수익성", exact: true }).click();
  await page.getByLabel("조회 단위").selectOption("day");
  await page.getByLabel("조회 날짜").fill("2026-09-19");
  await expect(
    page.getByRole("row").filter({ hasText: "아메리카노" }),
  ).toContainText("40,168원");
  await page
    .getByRole("link", { name: "대시보드 / 기간 손익", exact: true })
    .click();
  await expect(page.getByRole("main")).toContainText("40,168원");
  await page.getByRole("link", { name: "재료 잔량", exact: true }).click();
  await page.getByLabel("재고 기준일").fill("2026-09-19");
  await expect(page.getByTestId("stock-I01")).toHaveText("4,080 g");
  await page.reload();
  await expect(page.getByTestId("sale-count")).toHaveText("6,113");
  await data(page);
  const revision = (await read(page)).revision;
  await upload(page, file);
  await expect(
    page.getByText("새 기록 0건 · 중복 제외 1건 · 오류 0건"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "가져오기 확정", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("추가 0건");
  expect((await read(page)).revision).toBe(revision);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
test("S12 비용 양식·가져오기→손익 연결·ID없는 반복 오류·동일ID 제외", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("가져올 기록").selectOption("expenses");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "양식 내려받기", exact: true })
    .click();
  const out = await download;
  expect(out.suggestedFilename()).toBe("비용기록_입력양식.xlsx");
  const file = await fixture("expenses", [["", "2026-09-19", "임차료", 10000]]);
  await upload(page, file, "비용.xlsx");
  await page
    .getByRole("button", { name: "가져오기 확정", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("추가 1건");
  const saved = await read(page);
  expect(saved.dataset.expenses).toHaveLength(3561);
  expect(saved.dataset.inventory_events).toEqual(d.inventory_events);
  await page
    .getByRole("link", { name: "대시보드 / 기간 손익", exact: true })
    .click();
  await page.getByLabel("조회 단위").selectOption("day");
  await page.getByLabel("조회 날짜").fill("2026-09-19");
  await expect(page.getByRole("main")).toContainText("-10,000원");
  await data(page);
  await page.getByLabel("가져올 기록").selectOption("expenses");
  await upload(page, file, "비용.xlsx");
  await expect(page.getByRole("alert")).toContainText("식별할 수 없습니다");
  await expect(
    page.getByRole("button", { name: "가져오기 확정", exact: true }),
  ).toBeDisabled();
  const e = saved.dataset.expenses.at(-1)!;
  await upload(
    page,
    await fixture("expenses", [[e.expense_id, e.date, e.category, e.amount]]),
    "비용_ID.xlsx",
  );
  await expect(
    page.getByText("새 기록 0건 · 중복 제외 1건 · 오류 0건"),
  ).toBeVisible();
});
test("S11 오류 파일 전체 미반영·취소·쓰기 실패·입력파일 불변", async ({
  page,
}) => {
  await start(page);
  const before = await read(page),
    bad = [...sale];
  bad[2] = "M99";
  const mixed = await fixture("sales", [sale, bad]);
  const copy = Buffer.from(mixed);
  await upload(page, mixed);
  await expect(page.getByRole("alert")).toContainText("3행");
  await expect(
    page.getByRole("button", { name: "가져오기 확정", exact: true }),
  ).toBeDisabled();
  expect(await read(page)).toEqual(before);
  expect(mixed.equals(copy)).toBe(true);
  await upload(page, await fixture("sales", [sale]));
  await page
    .getByRole("button", { name: "가져오기 취소", exact: true })
    .click();
  expect(await read(page)).toEqual(before);
  await upload(page, await fixture("sales", [sale]));
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === "appState")
        throw new DOMException("검사용 저장 실패", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await page
    .getByRole("button", { name: "가져오기 확정", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("저장 실패");
  expect(await read(page)).toEqual(before);
  await expect(
    page.getByRole("heading", { name: "가져오기 검사 결과" }),
  ).toBeVisible();
});
test("S13~S14 실제 백업→판매/비용/재고 변경→전체 복원·확인란·취소·재실행", async ({
  page,
}) => {
  await start(page);
  const original = await read(page),
    path = await backup(page);
  await page.screenshot({
    path: "docs/evidence/epic3-backup.png",
    fullPage: true,
  });
  await upload(page, await fixture("sales", [sale]));
  await page
    .getByRole("button", { name: "가져오기 확정", exact: true })
    .click();
  await expect(page.getByTestId("sale-count")).toHaveText("6,113");
  await page.getByLabel("가져올 기록").selectOption("expenses");
  await upload(
    page,
    await fixture("expenses", [["", "2026-09-19", "임차료", 10000]]),
    "비용.xlsx",
  );
  await page
    .getByRole("button", { name: "가져오기 확정", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("추가 1건");
  await page.getByRole("link", { name: "재료 잔량", exact: true }).click();
  await page.getByLabel("재고 기준일").fill("2026-09-19");
  await page
    .getByRole("row")
    .filter({ has: page.getByTestId("stock-I01") })
    .getByRole("button", { name: "입고", exact: true })
    .click();
  await page.getByLabel("입고 수량 (g)", { exact: true }).fill("1000");
  await page.getByRole("button", { name: "입고 저장", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await data(page);
  const changed = await read(page);
  await restoreFile(page, path);
  await page
    .getByRole("button", { name: "전체 교체 복원", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("확인");
  expect(await read(page)).toEqual(changed);
  await page.getByRole("button", { name: "복원 취소", exact: true }).click();
  expect(await read(page)).toEqual(changed);
  await restoreFile(page, path);
  await page.screenshot({
    path: "docs/evidence/epic3-restore-preview.png",
    fullPage: true,
  });
  await confirmRestore(page);
  const restored = await read(page);
  expect(restored.dataset).toEqual(original.dataset);
  expect(restored.reviewRequiredDates).toEqual(original.reviewRequiredDates);
  expect(restored.revision).toBe(changed.revision + 1);
  await page.reload();
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  expect((await read(page)).dataset).toEqual(original.dataset);
  await page.getByRole("link", { name: "메뉴 수익성", exact: true }).click();
  await page.getByLabel("조회 단위").selectOption("day");
  await page.getByLabel("조회 날짜").fill("2026-09-19");
  await expect(page.getByTestId("period-status")).toContainText("기록 없음");
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await page.getByRole("link", { name: "재료 잔량", exact: true }).click();
  await page.getByLabel("재고 기준일").fill("2026-09-19");
  await expect(page.getByTestId("stock-I01")).toHaveText("4,280 g");
});
test("S14 손상/미지원/빈 파일은 보존, 유효 빈 백업은 명시 확인 후 보존", async ({
  page,
}) => {
  await start(page);
  const before = await read(page),
    { makeBackup } = await import("../../src/files/backup");
  for (const text of [
    "",
    JSON.stringify(raw),
    JSON.stringify({ ...makeBackup(before), backupVersion: 99 }),
  ]) {
    await page.getByLabel("백업 복원 파일").setInputFiles({
      name: "잘못된.json",
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await read(page)).toEqual(before);
  }
  const empty = {
    ...before,
    dataset: {
      ...before.dataset,
      sales: [],
      expenses: [],
      inventory_events: [],
    },
  };
  await page.getByLabel("백업 복원 파일").setInputFiles({
    name: "빈_백업.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(makeBackup(empty))),
  });
  await expect(
    page.getByText(
      "유효한 빈 백업입니다. 현재 판매·비용·재고 기록이 모두 비워집니다.",
    ),
  ).toBeVisible();
  await confirmRestore(page);
  await page.reload();
  await expect(page.getByTestId("sale-count")).toHaveText("0");
  expect((await read(page)).dataset.expenses).toHaveLength(0);
});
test("S14 복원/가져오기 검사 후 다른 탭 변경은 차단, 복원 통지는 이전 입력 폐기", async ({
  page,
  context,
}) => {
  await start(page);
  const file = await backup(page),
    second = await context.newPage();
  await second.goto("/");
  await expect(second.getByTestId("sale-count")).toHaveText("6,112");
  await data(second);
  await restoreFile(page, file);
  await upload(second, await fixture("sales", [sale]));
  await second
    .getByRole("button", { name: "가져오기 확정", exact: true })
    .click();
  await expect(second.getByTestId("sale-count")).toHaveText("6,113");
  await expect(
    page.getByRole("button", { name: "전체 교체 복원", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "새로 읽기", exact: true })
    .first()
    .click();
  await restoreFile(page, file);
  await second.getByRole("button", { name: "판매 입력", exact: true }).click();
  await second.getByLabel("판매수량 (개)", { exact: true }).fill("12");
  await confirmRestore(page);
  await expect(second.getByRole("dialog")).not.toBeVisible();
  await expect(second.getByRole("alert")).toContainText("다른 탭에서 변경");
  expect((await read(second)).dataset.sales).toHaveLength(6112);
  await second
    .getByRole("button", { name: "새로 읽기", exact: true })
    .first()
    .click();
  await data(second);
  await upload(second, await fixture("sales", [sale]));
  await upload(page, await fixture("sales", [sale]));
  await page
    .getByRole("button", { name: "가져오기 확정", exact: true })
    .click();
  await expect(
    second.getByRole("button", { name: "가져오기 확정", exact: true }),
  ).toBeDisabled();
  expect((await read(second)).dataset.sales).toHaveLength(6113);
});
test("S14 복원 쓰기 실패 시 전체 이전 상태 보존", async ({ page }) => {
  await start(page);
  const file = await backup(page);
  await upload(page, await fixture("sales", [sale]));
  await page
    .getByRole("button", { name: "가져오기 확정", exact: true })
    .click();
  await expect(page.getByTestId("sale-count")).toHaveText("6,113");
  const before = await read(page);
  await restoreFile(page, file);
  await page.getByRole("checkbox").check();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === "appState") throw Error("검사용 복원 쓰기 실패");
      return put.apply(this, args);
    };
  });
  await page
    .getByRole("button", { name: "전체 교체 복원", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("쓰기 실패");
  expect(await read(page)).toEqual(before);
});
test("파일 한도·취소·처리 중 입력 차단·Worker 실패와 시간 초과 보존", async ({
  page,
}) => {
  await start(page);
  const before = await read(page);
  await page.getByLabel("엑셀 파일").setInputFiles({
    name: "큰파일.xlsx",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("alert")).toContainText("10MiB");
  expect(await read(page)).toEqual(before);
  await page.evaluate(() => {
    class DelayedWorker extends EventTarget {
      onmessage = null;
      onerror = null;
      postMessage() {}
      terminate() {}
    }
    window.Worker = DelayedWorker as unknown as typeof Worker;
  });
  await page.getByLabel("엑셀 파일").setInputFiles({
    name: "취소.xlsx",
    mimeType: "application/octet-stream",
    buffer: await fixture("sales", [sale]),
  });
  await expect(
    page.getByRole("button", { name: "판매 입력", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "파일 처리 취소", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("취소");
  expect(await read(page)).toEqual(before);
  await page.clock.install();
  await page.getByLabel("엑셀 파일").setInputFiles({
    name: "시간초과.xlsx",
    mimeType: "application/octet-stream",
    buffer: await fixture("sales", [sale]),
  });
  await expect(
    page.getByRole("button", { name: "파일 처리 취소", exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(30001);
  await expect(page.getByRole("alert")).toContainText("30초");
  expect(await read(page)).toEqual(before);
  await page.evaluate(() => {
    class FailedWorker extends EventTarget {
      onmessage = null;
      onerror: (() => void) | null = null;
      postMessage() {
        queueMicrotask(() => this.onerror?.());
      }
      terminate() {}
    }
    window.Worker = FailedWorker as unknown as typeof Worker;
  });
  await page.getByLabel("엑셀 파일").setInputFiles({
    name: "실패.xlsx",
    mimeType: "application/octet-stream",
    buffer: await fixture("sales", [sale]),
  });
  await expect(page.getByRole("alert")).toContainText(
    "처리 도구를 열지 못했습니다",
  );
  expect(await read(page)).toEqual(before);
});
test("1만 행 검사와 기준 규모 백업·복원 3회 성능", async ({ page }, info) => {
  test.setTimeout(120000);
  await start(page);
  await page.getByLabel("가져올 기록").selectOption("expenses");
  const file = await fixture(
    "expenses",
    Array.from({ length: 10000 }, (_, i) => [
      "PERF" + i,
      "2026-09-19",
      "임차료",
      1,
    ]),
  );
  const inspection: number[] = [],
    exports: number[] = [],
    restores: number[] = [];
  for (let i = 0; i < 3; i++) {
    const begin = Date.now();
    await upload(page, file, "1만행.xlsx");
    inspection.push(Date.now() - begin);
    await expect(
      page.getByText("새 기록 10000건 · 중복 제외 0건 · 오류 0건"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "가져오기 취소", exact: true })
      .click();
    expect((await read(page)).dataset.expenses).toHaveLength(3560);
  }
  for (let i = 0; i < 3; i++) {
    let begin = Date.now();
    const path = await backup(page);
    exports.push(Date.now() - begin);
    begin = Date.now();
    await restoreFile(page, path);
    await confirmRestore(page);
    restores.push(Date.now() - begin);
    expect((await read(page)).dataset.sales).toHaveLength(6112);
  }
  info.annotations.push({
    type: "performance-ms",
    description: JSON.stringify({
      browser: "Edge",
      rows: 10000,
      inspection,
      exports,
      restores,
    }),
  });
  await info.attach("performance.json", {
    body: JSON.stringify({ inspection, exports, restores }),
    contentType: "application/json",
  });
  expect(Math.max(...inspection)).toBeLessThan(10000);
  expect(Math.max(...exports, ...restores)).toBeLessThan(5000);
});
test("손상된 저장 상태에서 백업 복원으로 회복", async ({ page }) => {
  await start(page);
  const path = await backup(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("prep-cafe");
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("appState", "readwrite");
          tx.objectStore("appState").put({
            id: "current",
            revision: 88,
            initialized: true,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "기존 자료는 덮어쓰지 않았습니다",
  );
  await restoreFile(page, path);
  await confirmRestore(page);
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  expect((await read(page)).revision).toBe(89);
});
