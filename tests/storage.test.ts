import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import raw from "../data/매장운영데이터.json";
import { normalizeSample, type State } from "../src/domain/model";
import { prepareSale } from "../src/domain/calculations";
import { CafeDB, loadOrSeed, appendSale } from "../src/storage/db";
const input = {
  date: "2026-09-19",
  menu_id: "M01",
  channel: "포장",
  quantity: "10",
  unit_price: "5000",
  discount_amount: "2000",
  payment_fee: "1200",
};
const sample = normalizeSample(raw);
it("초기화 한 번, 재실행 보존, 실제 저장·변경번호 증가", async () => {
  const db = new CafeDB("test-" + crypto.randomUUID());
  let seeds = 0;
  const loader = async () => {
    seeds++;
    return sample;
  };
  const s = await loadOrSeed(db, loader);
  const next = await appendSale(
    s,
    prepareSale(s.dataset, input, "2026-10-12"),
    db,
  );
  const read = await loadOrSeed(db, loader);
  expect(read.dataset.sales).toHaveLength(6113);
  expect(read.revision).toBe(next.revision);
  expect(seeds).toBe(1);
  await db.delete();
});
it("오래된 변경번호·저장 중단 시 기존 자료 보존", async () => {
  const db = new CafeDB("test-" + crypto.randomUUID());
  const s = await loadOrSeed(db, async () => sample);
  await appendSale(s, prepareSale(s.dataset, input, "2026-10-12"), db);
  await expect(
    appendSale(
      s,
      prepareSale(s.dataset, { ...input, channel: "매장" }, "2026-10-12"),
      db,
    ),
  ).rejects.toThrow(/다른 탭/);
  expect((await db.appState.get("current"))!.dataset.sales).toHaveLength(6113);
  db.appState.hook("updating", () => {
    throw Error("의도한 저장 실패");
  });
  const latest = await loadOrSeed(db);
  await expect(
    appendSale(
      latest,
      prepareSale(latest.dataset, { ...input, channel: "매장" }, "2026-10-12"),
      db,
    ),
  ).rejects.toThrow();
  expect((await db.appState.get("current"))!.revision).toBe(1);
  await db.delete();
});
it("손상 자료를 샘플로 자동 덮어쓰지 않음, 빈 복원 상태를 보존", async () => {
  const db = new CafeDB("test-" + crypto.randomUUID());
  await db.appState.put({
    id: "current",
    initialized: true,
    revision: 9,
  } as State & { id: "current" });
  await expect(loadOrSeed(db, async () => sample)).rejects.toThrow();
  expect((await db.appState.get("current"))!.revision).toBe(9);
  const empty = { ...sample, sales: [], expenses: [], inventory_events: [] };
  const state: State = {
    dataset: empty,
    initialized: true,
    schemaVersion: 1,
    calculationVersion: 1,
    revision: 10,
    savedAt: new Date().toISOString(),
    reviewRequiredDates: [],
  };
  await db.appState.put({ ...state, id: "current" });
  expect((await loadOrSeed(db, async () => sample)).dataset.sales).toHaveLength(
    0,
  );
  await db.delete();
});
it("처음 시작을 동시에 해도 샘플을 한 번만 확정", async () => {
  const db = new CafeDB("test-" + crypto.randomUUID());
  const [a, b] = await Promise.all([
    loadOrSeed(db, async () => sample),
    loadOrSeed(db, async () => sample),
  ]);
  expect(a.revision).toBe(0);
  expect(b.revision).toBe(0);
  expect((await db.appState.get("current"))!.dataset.sales).toHaveLength(6112);
  await db.delete();
});
