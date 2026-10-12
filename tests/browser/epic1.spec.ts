import { test, expect, type Page } from "@playwright/test";
async function fillSale(
  page: Page,
  opts: { date?: string; channel?: string; fee?: string } = {},
) {
  await page.getByRole("button", { name: "판매 입력", exact: true }).click();
  await page
    .getByLabel("판매일", { exact: true })
    .fill(opts.date ?? "2026-09-19");
  await page.getByLabel("메뉴", { exact: true }).selectOption("M01");
  await page
    .getByLabel("판매채널", { exact: true })
    .selectOption(opts.channel ?? "포장");
  await page.getByLabel("판매수량 (개)", { exact: true }).fill("10");
  await page.getByLabel("실제 판매단가 (원)", { exact: true }).fill("5000");
  await page.getByLabel("전체 할인액 (원)", { exact: true }).fill("2000");
  await page
    .getByLabel("전체 결제수수료 (원)", { exact: true })
    .fill(opts.fee ?? "1200");
}
test("S01~S05 실제 판매→수익성→손익→재고→재실행, 콘솔·외부전송 검사", async ({
  page,
}) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:5173") &&
      !r.url().startsWith("data:")
    )
      external.push(r.url());
  });
  const start = Date.now();
  await page.goto("/");
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  const loadMs = Date.now() - start;
  test
    .info()
    .annotations.push({ type: "initialLoadMs", description: String(loadMs) });
  expect(loadMs).toBeLessThan(5000);
  await page.screenshot({
    path: "docs/evidence/epic1-dashboard-1440.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "재료 잔량", exact: true }).click();
  await page.getByLabel("재고 기준일").fill("2026-09-19");
  const bean = Number(
    (await page.getByTestId("stock-I01").innerText())
      .replaceAll(",", "")
      .replace(" g", ""),
  );
  const cups = Number(
    (await page.getByTestId("stock-I10").innerText())
      .replaceAll(",", "")
      .replace(" 개", ""),
  );
  await fillSale(page);
  await expect(page.getByRole("dialog")).toContainText("48,000원");
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  const saveStart = Date.now();
  await page.getByRole("button", { name: "판매 저장", exact: true }).dblclick();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const saveMs = Date.now() - saveStart;
  test
    .info()
    .annotations.push({ type: "saveAndRenderMs", description: String(saveMs) });
  expect(saveMs).toBeLessThan(1000);
  await expect(page.getByTestId("sale-count")).toHaveText("6,113");
  await page.getByRole("link", { name: "판매 기록", exact: true }).click();
  const salesRow = page.getByRole("row").filter({ hasText: "아메리카노" });
  await expect(salesRow).toContainText("48,000원");
  await expect(salesRow).toContainText("1,200원");
  await expect(salesRow).toContainText("포장");
  await page.getByRole("link", { name: "메뉴 수익성", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "아메리카노" }),
  ).toContainText("48,000원");
  await expect(
    page.getByRole("row").filter({ hasText: "아메리카노" }),
  ).toContainText("40,168원");
  await page.getByRole("button", { name: "아메리카노", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "아메리카노 · 레시피 근거" }),
  ).toBeVisible();
  await page.getByLabel("판매채널", { exact: true }).selectOption("매장");
  await expect(page.getByText("선택 조건의 판매 없음")).toBeVisible();
  await page.getByLabel("판매채널", { exact: true }).selectOption("포장");
  await page.screenshot({
    path: "docs/evidence/epic1-menu-1440.png",
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "대시보드 / 기간 손익", exact: true })
    .click();
  await expect(
    page.locator(".metric").filter({ hasText: "순매출" }),
  ).toContainText("48,000원");
  await expect(
    page.locator(".metric").filter({ hasText: "운영 참고 손익" }),
  ).toContainText("40,168원");
  await expect(page.getByTestId("period-status")).toContainText("미마감");
  await page.getByLabel("조회 단위").selectOption("month");
  await expect(page.getByLabel("조회 월")).toHaveValue("2026-09");
  await expect(
    page.locator(".metric").filter({ hasText: "순매출" }),
  ).toContainText("14,016,930원");
  const metrics = await page.locator(".metrics").innerText();
  await page.getByLabel("정렬").selectOption("income");
  await page.getByRole("button", { name: "전체 일자 펼쳐보기" }).click();
  expect(await page.locator(".metrics").innerText()).toBe(metrics);
  await page.getByRole("link", { name: "재료 잔량", exact: true }).click();
  await expect(page.getByTestId("stock-I01")).toHaveText(
    (bean - 200).toLocaleString("ko-KR") + " g",
  );
  await expect(page.getByTestId("stock-I10")).toHaveText(
    (cups - 10).toLocaleString("ko-KR") + " 개",
  );
  await page.getByLabel("재료명·공급사 검색").fill("원두");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
  await page.getByLabel("재료명·공급사 검색").fill("");
  await page.screenshot({
    path: "docs/evidence/epic1-stock-1440.png",
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByTestId("sale-count")).toHaveText("6,113");
  await page.getByRole("link", { name: "판매 기록", exact: true }).click();
  await page.getByLabel("조회 단위").selectOption("day");
  await page.getByLabel("조회 날짜").fill("2026-09-19");
  await expect(
    page.getByRole("row").filter({ hasText: "아메리카노" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("row").filter({ hasText: "아메리카노" }),
  ).toContainText("48,000원");
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
test("필수 수수료·할인·중복·취소 오류가 확정 자료를 바꾸지 않음", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  await fillSale(page, { fee: "" });
  await page.getByRole("button", { name: "판매 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("전체 결제수수료");
  await expect(page.getByLabel("판매수량 (개)", { exact: true })).toHaveValue(
    "10",
  );
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  await page.getByLabel("전체 결제수수료 (원)", { exact: true }).fill("0");
  await page.getByLabel("전체 할인액 (원)", { exact: true }).fill("50001");
  await page.getByRole("button", { name: "판매 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("할인액");
  await page.getByLabel("전체 할인액 (원)", { exact: true }).fill("2000");
  await page.getByLabel("판매일", { exact: true }).fill("2026-09-18");
  await page.getByRole("button", { name: "판매 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("같은 날짜");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
});
test("두 탭 충돌에서 입력 보존·저장 차단·새로 읽기 후 저장", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByTestId("sale-count")).toHaveText("6,112");
  await fillSale(second, { channel: "매장" });
  await fillSale(page);
  await page.getByRole("button", { name: "판매 저장", exact: true }).click();
  await expect(page.getByTestId("sale-count")).toHaveText("6,113");
  await expect(
    second.getByRole("button", { name: "판매 저장", exact: true }),
  ).toBeDisabled();
  await expect(second.getByLabel("판매수량 (개)", { exact: true })).toHaveValue(
    "10",
  );
  await second
    .getByRole("dialog")
    .getByRole("button", { name: "새로 읽기", exact: true })
    .click();
  await expect(
    second.getByRole("button", { name: "판매 저장", exact: true }),
  ).toBeEnabled();
  await second.getByRole("button", { name: "판매 저장", exact: true }).click();
  await expect(second.getByTestId("sale-count")).toHaveText("6,114");
});
test("1280px·좁은 화면 이동과 입력창 저장·취소 접근", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "docs/evidence/epic1-dashboard-1280.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 1408 });
  await page.screenshot({
    path: "docs/evidence/epic1-design-1280.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 720, height: 900 });
  await fillSale(page);
  await expect(
    page.getByRole("button", { name: "판매 저장", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "취소", exact: true }),
  ).toBeInViewport();
});
test("실제 IndexedDB 저장 실패 시 성공 표시 없음·입력 유지·재실행 보존", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  await fillSale(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<typeof original>
    ) {
      if (this.name === "appState")
        throw new DOMException("테스트: 저장 용량 초과", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "판매 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("저장 용량 초과");
  await expect(page.getByLabel("판매수량 (개)", { exact: true })).toHaveValue(
    "10",
  );
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
});
test("손상된 실제 저장 상태를 샘플로 덮어쓰지 않음", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("sale-count")).toHaveText("6,112");
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
  const revision = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const r = indexedDB.open("prep-cafe");
        r.onsuccess = () => {
          const db = r.result,
            req = db
              .transaction("appState")
              .objectStore("appState")
              .get("current");
          req.onsuccess = () => {
            resolve(req.result.revision);
            db.close();
          };
        };
      }),
  );
  expect(revision).toBe(88);
});
