import { test, expect, type Page } from "@playwright/test";
import type { State } from "../../src/domain/model";
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
async function day(page: Page, date = "2026-09-19") {
  await page.getByLabel("조회 단위").selectOption("day");
  await page.getByLabel("조회 날짜").fill(date);
}
async function start(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
}
async function seedSale(page: Page) {
  await page.getByRole("button", { name: "판매 입력", exact: true }).click();
  await page.getByLabel("메뉴", { exact: true }).selectOption("M01");
  for (const [label, v] of [
    ["판매일", "2026-09-19"],
    ["판매수량 (개)", "10"],
    ["실제 판매단가 (원)", "5000"],
    ["전체 할인액 (원)", "2000"],
    ["전체 결제수수료 (원)", "1200"],
  ])
    await page.getByLabel(label, { exact: true }).fill(v);
  await page.getByLabel("판매채널", { exact: true }).selectOption("포장");
  await page.getByRole("button", { name: "판매 저장", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "판매 기록", exact: true }).click();
}
async function costs(page: Page) {
  await page.getByRole("link", { name: "판매 기록", exact: true }).click();
  await page.getByRole("button", { name: "비용 기록", exact: true }).click();
  await day(page);
}
async function inventory(page: Page, date = "2026-09-19") {
  await page.getByRole("link", { name: "재료 잔량", exact: true }).click();
  await page.getByLabel("재고 기준일").fill(date);
}
function bean(page: Page) {
  return page.getByRole("row").filter({ has: page.getByTestId("stock-I01") });
}
async function cancelDirty(page: Page) {
  page.once("dialog", (d) => void d.accept());
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "취소", exact: true })
    .click();
}
test("S06 판매 수량 수정→연관 계산→보존→삭제 취소/확정", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  await page.getByRole("link", { name: "판매 기록", exact: true }).click();
  await day(page, "2026-09-18");
  await page
    .getByRole("row")
    .filter({ hasText: "아메리카노포장30개" })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page.getByLabel("판매수량 (개)", { exact: true }).fill("32");
  await expect(page.getByRole("dialog")).toContainText("104,978원");
  await expect(page.getByRole("dialog")).toContainText("128,000원");
  await page.screenshot({
    path: "docs/evidence/epic2-user-step1.png",
    fullPage: false,
  });
  await cancelDirty(page);
  await seedSale(page);
  await day(page);
  await expect(
    page.getByRole("row").filter({ hasText: "2026-09-19" }),
  ).toHaveCount(1);
  const before = await read(page),
    old = before.dataset.sales.at(-1)!;
  await page.getByRole("button", { name: "수정", exact: true }).click();
  await page.getByLabel("판매수량 (개)", { exact: true }).fill("12");
  await expect(page.getByRole("dialog")).toContainText("48,842원");
  await expect(page.getByRole("dialog")).toContainText("당시 개당 원가를 유지");
  await page.getByRole("button", { name: "수정 저장", exact: true }).dblclick();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const next = await read(page),
    sale = next.dataset.sales.find((s) => s.sale_id === old.sale_id)!;
  expect(sale.quantity).toBe(12);
  expect(sale.unit_food_cost_snapshot).toBe(old.unit_food_cost_snapshot);
  expect(next.revision).toBe(before.revision + 1);
  await expect(page.getByTestId("sale-count")).toHaveText("6,113");
  await inventory(page);
  await expect(page.getByTestId("stock-I01")).toHaveText("4,040 g");
  await expect(page.getByTestId("stock-I10")).toHaveText("202 개");
  await page.getByRole("link", { name: "메뉴 수익성", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "아메리카노" }),
  ).toContainText("48,842원");
  await page.reload();
  await expect(page.getByTestId("sale-count")).toHaveText("6,113");
  await page.getByRole("link", { name: "판매 기록", exact: true }).click();
  await day(page);
  await page.screenshot({
    path: "docs/evidence/epic2-sales.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "취소", exact: true })
    .click();
  expect((await read(page)).dataset.sales).toHaveLength(6113);
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("button", { name: "삭제 확정", exact: true }).click();
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  await inventory(page);
  await expect(page.getByTestId("stock-I01")).toHaveText("4,280 g");
  await page.reload();
  expect(
    (await read(page)).dataset.sales.some((s) => s.sale_id === old.sale_id),
  ).toBe(false);
  expect(errors).toEqual([]);
});
test("S07 비용 검증·중복 확인·ID별 수정·귀속월 이동·삭제·재실행", async ({
  page,
}) => {
  await start(page);
  await costs(page);
  const original = await read(page);
  await page.getByRole("button", { name: "비용 입력", exact: true }).click();
  await page.getByRole("button", { name: "비용 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("금액");
  await page.getByLabel("비용 금액 (원)").fill("10000");
  await page.getByRole("button", { name: "비용 저장", exact: true }).dblclick();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const e = (await read(page)).dataset.expenses.at(-1)!;
  await expect(
    page.getByRole("heading", { name: "비용 기록 · 1건 · 10,000원" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "비용 입력", exact: true }).click();
  await page.getByLabel("비용 금액 (원)").fill("10000");
  await page.getByRole("button", { name: "비용 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("별도 지출");
  await page.getByLabel("기존 비용과 별도 지출임을 확인했습니다").check();
  await page.getByRole("button", { name: "비용 저장", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "수정", exact: true }).first().click();
  await page.getByLabel("귀속일").fill("2026-08-01");
  await page.getByLabel("비용 금액 (원)").fill("12000");
  await page
    .getByRole("button", { name: "비용 수정 저장", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    (await read(page)).dataset.expenses.find(
      (x) => x.expense_id === e.expense_id,
    )?.date,
  ).toBe("2026-08-01");
  await page
    .getByRole("row")
    .filter({ hasText: "12,000원" })
    .getByRole("button", { name: "삭제", exact: true })
    .click();
  await page.getByRole("button", { name: "삭제 확정", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  const saved = await read(page);
  expect(saved.dataset.expenses).toHaveLength(
    original.dataset.expenses.length + 1,
  );
  expect(saved.dataset.monthly_expense_plan).toEqual(
    original.dataset.monthly_expense_plan,
  );
  expect(saved.dataset.inventory_events).toEqual(
    original.dataset.inventory_events,
  );
  await costs(page);
  await page.screenshot({
    path: "docs/evidence/epic2-expenses.png",
    fullPage: true,
  });
});
test("S08~S10 입고·폐기·실사·다음날 변화·중복 차단·재실행", async ({
  page,
}) => {
  await start(page);
  const original = await read(page);
  await inventory(page);
  await bean(page).getByRole("button", { name: "입고", exact: true }).click();
  await page.getByLabel("입고 수량 (g)", { exact: true }).fill("1000");
  await page.getByLabel("입고 단위당 가격 (원, 선택)").fill("24.84");
  await expect(page.getByRole("dialog")).toContainText("5,280 g");
  await expect(page.getByTestId("stock-I01")).toHaveText("4,280 g");
  await page.getByRole("button", { name: "입고 저장", exact: true }).dblclick();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByTestId("stock-I01")).toHaveText("5,280 g");
  await bean(page).getByRole("button", { name: "폐기", exact: true }).click();
  await page.getByLabel("폐기 수량 (g)", { exact: true }).fill("100");
  await page.getByRole("button", { name: "폐기 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("사유");
  await page.getByLabel("사유", { exact: true }).fill("검사 폐기");
  await page.getByRole("button", { name: "폐기 저장", exact: true }).dblclick();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByTestId("stock-I01")).toHaveText("5,180 g");
  await bean(page).getByRole("button", { name: "실사", exact: true }).click();
  await page.getByLabel("실측 수량 (g)", { exact: true }).fill("5000");
  await page.getByLabel("사유", { exact: true }).fill("마감 실측");
  await expect(page.getByRole("dialog")).toContainText("실측과의 차이: -180 g");
  await page.getByRole("button", { name: "실사 확정", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("확인");
  await page.getByRole("checkbox").check();
  await page.screenshot({
    path: "docs/evidence/epic2-count-preview.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "실사 확정", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByTestId("stock-I01")).toHaveText("5,000 g");
  await bean(page).getByRole("button", { name: "실사", exact: true }).click();
  await page.getByLabel("실측 수량 (g)", { exact: true }).fill("5001");
  await page.getByLabel("사유", { exact: true }).fill("중복");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "실사 확정", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("이미");
  await cancelDirty(page);
  await page.getByLabel("재고 기준일").fill("2026-09-20");
  await bean(page).getByRole("button", { name: "입고", exact: true }).click();
  await page.getByLabel("입고 수량 (g)", { exact: true }).fill("1000");
  await page.getByRole("button", { name: "입고 저장", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByTestId("stock-I01")).toHaveText("6,000 g");
  await page.reload();
  await page.getByLabel("재고 기준일").fill("2026-09-20");
  await expect(page.getByTestId("stock-I01")).toHaveText("6,000 g");
  const saved = await read(page);
  expect(saved.dataset.inventory_events).toHaveLength(
    original.dataset.inventory_events.length + 4,
  );
  expect(saved.dataset.expenses).toEqual(original.dataset.expenses);
  expect(saved.dataset.sales).toEqual(original.dataset.sales);
  expect(saved.dataset.price_history).toEqual(original.dataset.price_history);
  await page.screenshot({
    path: "docs/evidence/epic2-inventory.png",
    fullPage: true,
  });
});
test("S08~S10 취소·음수 재고 경고·단위 오류·실측 0", async ({ page }) => {
  await start(page);
  await inventory(page);
  const original = await read(page);
  await bean(page).getByRole("button", { name: "입고", exact: true }).click();
  await page.getByLabel("입고 수량 (g)", { exact: true }).fill("1000");
  await cancelDirty(page);
  expect((await read(page)).revision).toBe(original.revision);
  await bean(page).getByRole("button", { name: "폐기", exact: true }).click();
  await page.getByLabel("폐기 수량 (g)", { exact: true }).fill("5000");
  await page.getByLabel("사유", { exact: true }).fill("실제 폐기");
  await expect(page.getByRole("dialog")).toContainText("음수 잔량");
  await page.getByRole("button", { name: "폐기 저장", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByTestId("stock-I01")).toHaveText("-720 g");
  await bean(page).getByRole("button", { name: "실사", exact: true }).click();
  await page.getByLabel("실측 수량 (g)", { exact: true }).fill("0");
  await page.getByLabel("사유", { exact: true }).fill("잔량 없음");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "실사 확정", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByTestId("stock-I01")).toHaveText("0 g");
  await bean(page).getByRole("button", { name: "입고", exact: true }).click();
  await page.getByLabel("재료", { exact: true }).selectOption("I10");
  await page.getByLabel("입고 수량 (개)", { exact: true }).fill("1.5");
  await page.getByRole("button", { name: "입고 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("개는 정수");
  expect((await read(page)).revision).toBe(original.revision + 2);
});
test("다른 탭의 비용 변경은 저장 차단, 입력 유지 후 재확인", async ({
  page,
  context,
}) => {
  await start(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByTestId("sale-count")).toHaveText("6,112");
  await costs(second);
  await second.getByRole("button", { name: "비용 입력", exact: true }).click();
  await second.getByLabel("비용 금액 (원)").fill("20000");
  await costs(page);
  await page.getByRole("button", { name: "비용 입력", exact: true }).click();
  await page.getByLabel("비용 금액 (원)").fill("10000");
  await page.getByRole("button", { name: "비용 저장", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    second.getByRole("button", { name: "비용 저장", exact: true }),
  ).toBeDisabled();
  await expect(second.getByLabel("비용 금액 (원)")).toHaveValue("20000");
  await second
    .getByRole("dialog")
    .getByRole("button", { name: "새로 읽기", exact: true })
    .click();
  await expect(
    second.getByRole("button", { name: "비용 저장", exact: true }),
  ).toBeEnabled();
  await second.getByRole("button", { name: "비용 저장", exact: true }).click();
  await expect(second.getByRole("dialog")).not.toBeVisible();
  expect((await read(second)).dataset.expenses).toHaveLength(3562);
});
test("재고 저장 실패는 이전 잔량·입력 보존, 성공 알림 없음", async ({
  page,
}) => {
  await start(page);
  await inventory(page);
  const original = await read(page);
  await bean(page).getByRole("button", { name: "입고", exact: true }).click();
  await page.getByLabel("입고 수량 (g)", { exact: true }).fill("1000");
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === "appState")
        throw new DOMException("검사용 저장 실패", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "입고 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("저장 실패");
  await expect(page.getByLabel("입고 수량 (g)", { exact: true })).toHaveValue(
    "1000",
  );
  await expect(page.getByTestId("stock-I01")).toHaveText("4,280 g");
  expect(await read(page)).toEqual(original);
  await cancelDirty(page);
  await page.reload();
  await page.getByLabel("재고 기준일").fill("2026-09-19");
  await expect(page.getByTestId("stock-I01")).toHaveText("4,280 g");
});
