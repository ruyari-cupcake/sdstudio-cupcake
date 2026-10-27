import type { Backend } from '../backend';

// ── 단일 쓰기 파이프라인 ──
// 상태 파일(JSON 등 "같은 경로에 반복 저장되는 파일")의 모든 쓰기가 여기를 거친다.
// 목적: 같은 파일에 여러 주체(주기 자동 저장·가시성 flush·종료 flush·디바운스 저장)가
// 동시에 쓰던 기존 구조의 "쓰기 경쟁" 을 구조적으로 제거한다.
//
// 보장:
//  - 직렬화: 같은 경로에 대한 쓰기는 도착 순서대로 하나씩 디스크에 반영된다.
//  - 병합(coalescing): 일반 상태 쓰기는 연속 대기 스냅숏 중 마지막 데이터만
//    기록한다. 원자적 교체는 각 호출의 저장 완료를 보장해야 하므로 병합하지 않는다.
//  - 원자적 교체: 임시 파일 쓰기와 rename을 같은 순서 처리 단위로 끝낸다.
//  - 경로 간 독립: 서로 다른 파일의 쓰기는 병렬로 진행되고 실패도 격리된다.
//
// 이미지 등 "한 번 쓰고 끝나는 유니크 경로" 파일은 경쟁이 없으므로 대상이 아니다.

type Settler = { resolve: () => void; reject: (e: any) => void };
type Writer = (data: string) => Promise<void>;
type PendingWrite = {
  data: string;
  writer: Writer;
  settlers: Settler[];
  coalescible: boolean;
};

export class PersistenceService {
  // 경로별 진행 중 펌프(쓰기 루프). 완료되면 스스로 제거된다.
  #pumps = new Map<string, Promise<void>>();

  // Atomic replacements are ordering barriers between coalescible snapshots.
  #queued = new Map<string, PendingWrite[]>();

  write(
    storage: Pick<Backend, 'writeFile'>,
    path: string,
    data: string,
  ): Promise<void> {
    return this.writeWith(path, data, (next) => storage.writeFile(path, next));
  }

  // 데이터 루트 밖의 반복 상태 파일도 같은 직렬화·병합 보장을 재사용한다.
  // key 는 큐 식별자일 뿐 실제 경로가 아니며, writer 가 저장 위치를 결정한다.
  writeWith(key: string, data: string, writer: Writer): Promise<void> {
    return this.#enqueue(key, data, writer, true);
  }

  // Manifest publication owns both steps until rename acknowledges this exact
  // candidate. Coalescing it with another snapshot would give a false success.
  writeAtomic(
    storage: Pick<Backend, 'writeFile' | 'renameFile'>,
    path: string,
    data: string,
  ): Promise<void> {
    return this.#enqueue(
      path,
      data,
      async (next) => {
        const temporary = `${path}.tmp`;
        await storage.writeFile(temporary, next);
        await storage.renameFile(temporary, path);
      },
      false,
    );
  }

  #enqueue(
    key: string,
    data: string,
    writer: Writer,
    coalescible: boolean,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queue = this.#queued.get(key) ?? [];
      const last = queue[queue.length - 1];
      if (coalescible && last?.coalescible) {
        last.data = data;
        last.writer = writer;
        last.settlers.push({ resolve, reject });
      } else {
        queue.push({
          data,
          writer,
          settlers: [{ resolve, reject }],
          coalescible,
        });
      }
      this.#queued.set(key, queue);
      this.#ensurePump(key);
    });
  }

  #ensurePump(path: string) {
    if (this.#pumps.has(path)) return;
    const pump = this.#pump(path).finally(() => {
      this.#pumps.delete(path);
      // 펌프 종료 마이크로태스크 직전에 끼어든 쓰기가 있으면 재가동 (유실 방지)
      if (this.#queued.has(path)) this.#ensurePump(path);
    });
    this.#pumps.set(path, pump);
  }

  async #pump(path: string) {
    for (;;) {
      const queue = this.#queued.get(path);
      const q = queue?.shift();
      if (!q) break;
      if (!queue?.length) this.#queued.delete(path);
      try {
        await q.writer(q.data);
        for (const s of q.settlers) s.resolve();
      } catch (e) {
        for (const s of q.settlers) s.reject(e);
      }
    }
  }

  // 특정 경로의 대기·진행 중 쓰기가 모두 디스크에 반영될 때까지 기다린다.
  // (삭제/이름변경 등 경로가 바뀌는 작업이 파일 rename 직전에 호출 —
  //  옛 경로로 향하던 잔여 쓰기가 rename 뒤에 파일을 되살리는 것을 방지)
  async flushPath(path: string): Promise<void> {
    while (this.#pumps.has(path)) {
      await this.#pumps.get(path)!.catch(() => {});
    }
  }

  // 대기·진행 중인 모든 쓰기가 끝날 때까지 기다린다 (종료 flush 용).
  // 기다리는 동안 새로 들어온 쓰기까지 포함해 큐가 완전히 빌 때까지 반복한다.
  async flushAll(): Promise<void> {
    while (this.#pumps.size > 0) {
      await Promise.allSettled([...this.#pumps.values()]);
    }
  }
}

// The shared queue owns ordering, snapshot coalescing and atomic replacement.
// Storage is explicit, so importing persistence never boots the app.
export const persistService = new PersistenceService();
