import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

// Serve the actual build with the same security headers planned for Vercel.
const root = resolve("dist");
const config = JSON.parse(await readFile("vercel.json", "utf8"));
const headers = Object.fromEntries(
  config.headers[0].headers.map((h) => [h.key, h.value]),
);
const server = createServer(async (request, response) => {
  try {
    const path = resolve(
      root,
      "." + new URL(request.url, "http://localhost").pathname,
    );
    if (path !== root && !path.startsWith(root + sep)) {
      response.writeHead(403);
      response.end();
      return;
    }
    const file = path === root ? resolve(root, "index.html") : path;
    const content = await readFile(file);
    response.writeHead(200, {
      ...headers,
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
        }[extname(file)] ?? "application/octet-stream",
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const channel = process.env.PRODUCTION_BROWSER ?? "msedge";
const browser = await chromium.launch({ channel, headless: true });
const timings = [],
  issues = [],
  external = [];
try {
  const response = await fetch(base + "/");
  for (const [name, value] of Object.entries(headers))
    assert.equal(response.headers.get(name), value);
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => issues.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") issues.push(message.text());
    });
    page.on("request", (r) => {
      if (
        !r.url().startsWith(base) &&
        !r.url().startsWith("blob:") &&
        !r.url().startsWith("data:")
      )
        external.push(r.url());
    });
    let start = Date.now();
    await page.goto(base + "/");
    await page.getByTestId("sale-count").filter({ hasText: "6,112" }).waitFor();
    const first = Date.now() - start;
    await page
      .getByRole("link", { name: "백업 및 데이터 관리", exact: true })
      .click();
    let download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "양식 내려받기", exact: true })
      .click();
    const template = await download;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(await template.path());
    wb.worksheets[1].addRow([
      "",
      "2026-09-19",
      "M01",
      "포장",
      10,
      5000,
      2000,
      1200,
    ]);
    await page.getByLabel("엑셀 파일", { exact: true }).setInputFiles({
      name: "판매.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    });
    await page.getByRole("heading", { name: "가져오기 검사 결과" }).waitFor();
    start = Date.now();
    await page
      .getByRole("button", { name: "가져오기 확정", exact: true })
      .click();
    await page.getByTestId("sale-count").filter({ hasText: "6,113" }).waitFor();
    const save = Date.now() - start;
    start = Date.now();
    download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "전체 백업 내려받기", exact: true })
      .click();
    const file = await download,
      bytes = await readFile(await file.path());
    const backup = Date.now() - start;
    start = Date.now();
    await page.getByLabel("백업 복원 파일", { exact: true }).setInputFiles({
      name: "전체.json",
      mimeType: "application/json",
      buffer: bytes,
    });
    await page.getByRole("heading", { name: "복원 전 확인" }).waitFor();
    await page.getByRole("checkbox").check();
    await page
      .getByRole("button", { name: "전체 교체 복원", exact: true })
      .click();
    await page.getByRole("status").filter({ hasText: "복원을 완료" }).waitFor();
    const restore = Date.now() - start;
    await page.reload();
    await page.getByTestId("sale-count").filter({ hasText: "6,113" }).waitFor();
    if (i === 2)
      await page.screenshot({
        path: "docs/evidence/epic3-production.png",
        fullPage: true,
      });
    timings.push({ first, save, backup, restore });
    assert(
      first < 5000 && save < 1000 && backup < 5000 && restore < 5000,
      JSON.stringify(timings),
    );
    await context.close();
  }
  assert.deepEqual(issues, []);
  assert.deepEqual(external, []);
  const result = {
    success: true,
    browser: channel,
    build: "dist",
    rounds: 3,
    securityHeaders: headers,
    timingsMs: timings,
    consoleErrors: issues,
    externalRequests: external,
  };
  await writeFile(
    `docs/evidence/epic3-production-${channel}-results.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
