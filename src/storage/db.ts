import Dexie, { type Table } from "dexie";
import {
  validateState,
  validateDataset,
  normalizeSample,
  type State,
  type Dataset,
  type Sale,
} from "../domain/model";
export class CafeDB extends Dexie {
  appState!: Table<State & { id: "current" }, string>;
  constructor(name = "prep-cafe") {
    super(name);
    this.version(1).stores({ appState: "id" });
  }
}
export const db = new CafeDB();
export async function loadOrSeed(
  database = db,
  loader: () => Promise<Dataset> = async () => {
    const r = await fetch("/sample.json");
    if (!r.ok) throw Error("샘플 파일을 읽을 수 없습니다.");
    return normalizeSample(await r.json());
  },
) {
  const existing = await database.appState.get("current");
  if (existing) return validateState(existing);
  const dataset = await loader();
  validateDataset(dataset);
  const candidate: State = {
    schemaVersion: 1,
    calculationVersion: 1,
    revision: 0,
    savedAt: new Date().toISOString(),
    initialized: true,
    reviewRequiredDates: [],
    dataset,
  };
  return database.transaction("rw", database.appState, async () => {
    const raced = await database.appState.get("current");
    if (raced) return validateState(raced);
    await database.appState.put({ ...candidate, id: "current" });
    return candidate;
  });
}
export async function appendSale(state: State, sale: Sale, database = db) {
  const dataset = { ...state.dataset, sales: [...state.dataset.sales, sale] };
  return commitDataset(state, dataset, [sale.date], database);
}
export async function commitDataset(
  state: State,
  dataset: Dataset,
  changedDates: string[],
  database = db,
) {
  validateDataset(dataset);
  const reviewRequiredDates = [...state.reviewRequiredDates];
  for (const date of changedDates)
    if (
      dataset.calendar.some((c) => c.date === date && c.record_complete) &&
      !reviewRequiredDates.includes(date)
    )
      reviewRequiredDates.push(date);
  const next: State = {
    ...state,
    dataset,
    reviewRequiredDates,
    revision: state.revision + 1,
    savedAt: new Date().toISOString(),
  };
  await database.transaction("rw", database.appState, async () => {
    const current = await database.appState.get("current");
    if (!current || current.revision !== state.revision)
      throw Error(
        "다른 탭에서 기록이 변경되었습니다. 입력을 보관한 채 새로 읽기를 누르고 다시 확인하세요.",
      );
    validateState(current);
    await database.appState.put({ ...next, id: "current" });
  });
  return next;
}
export async function readSavedState(database = db) {
  const current = await database.appState.get("current");
  if (!current) throw Error("저장 완료된 자료가 없습니다.");
  return validateState(current);
}
export async function restoreState(
  expectedRevision: number | null,
  candidate: State,
  database = db,
) {
  const checked = validateState(candidate);
  return database.transaction("rw", database.appState, async () => {
    const current = await database.appState.get("current");
    const revision = Number.isSafeInteger(current?.revision)
      ? current!.revision
      : null;
    if (revision !== expectedRevision)
      throw Error(
        "다른 탭에서 변경되었습니다. 다시 읽고 복원 파일을 다시 검사하세요.",
      );
    if (current?.schemaVersion !== undefined && current.schemaVersion !== 1)
      throw Error(
        "현재 자료는 다른 버전입니다. 지원하는 프로그램으로 열어주세요.",
      );
    const next: State = {
      ...checked,
      revision: (revision ?? 0) + 1,
      savedAt: new Date().toISOString(),
    };
    await database.appState.put({ ...next, id: "current" });
    return next;
  });
}
