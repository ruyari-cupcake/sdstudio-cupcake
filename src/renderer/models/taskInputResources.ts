import type {
  CharacterReference,
  ModelVersion,
  Vibe,
} from '../backends/imageGen';
import type { NaiModelCapabilities } from '../backends/genVendors/naiModelCapabilities';
import type { ImageService } from './ImageService';
import { dataUriToBase64 } from './imageDataUri';
import type { TaskQueueRun } from './TaskQueueService';
import type { SDAbstractJob, Session } from './types';
import type { NaiRequestOptions } from './requestTiming';
import { StaleAttemptError, throwIfAborted } from './requestTiming';

// Defaults for older saved jobs that predate explicit precise-reference controls.
const DEFAULT_REFERENCE_STRENGTH = 0.6;
const DEFAULT_REFERENCE_FIDELITY = 1;

type ResourceLoader = Pick<
  ImageService,
  | 'fetchReferenceImage'
  | 'reencodeReferenceForApi'
  | 'checkEncodedVibeImage'
  | 'encodeVibeImage'
  | 'fetchEncodedVibeImage'
>;

interface TaskImageResourceInput {
  session: Session;
  job: Pick<SDAbstractJob<unknown>, 'vibes' | 'characterReferences'>;
  run: TaskQueueRun;
  modelVersion?: ModelVersion;
  capabilities: Pick<
    NaiModelCapabilities,
    'supportsVibeTransfer' | 'supportsCharacterReference' | 'maxVibeImages'
  >;
  request?: NaiRequestOptions;
}

function retainActiveKeys<T>(cache: Map<string, T>, keys: ReadonlySet<string>) {
  cache.forEach((_value, key) => {
    if (!keys.has(key)) cache.delete(key);
  });
}

function throwIfPreparationStopped(
  run: TaskQueueRun,
  signal?: AbortSignal,
): void {
  throwIfAborted(signal);
  if (run.stopped) throw new StaleAttemptError();
}

function propagateUncertainRequest(
  error: unknown,
  run: TaskQueueRun,
  signal?: AbortSignal,
) {
  if (
    error !== null &&
    typeof error === 'object' &&
    'outcomeUnknown' in error &&
    error.outcomeUnknown === true
  ) {
    throw error;
  }
  throwIfPreparationStopped(run, signal);
}

/**
 * Resolve capability conflicts before any paid encoding or expensive decode.
 * Retain only the current task's inputs in memory; disk encodings remain reusable.
 * Sequential preparation bounds peak decoder/encoder work without sleeps or deadlines.
 */
export async function prepareTaskImageResources(
  {
    session,
    job,
    run,
    modelVersion,
    capabilities,
    request,
  }: TaskImageResourceInput,
  loader: ResourceLoader,
  notify: (message: string) => void,
): Promise<{ references: CharacterReference[]; vibes: Vibe[] }> {
  throwIfPreparationStopped(run, request?.signal);
  if (run.lastSessionName !== session.name) {
    run.cachedVibes = new Map();
    run.cachedReferences = new Map();
    run.lastSessionName = session.name;
  }
  run.cachedVibes ??= new Map();
  run.cachedReferences ??= new Map();

  const enabledReferences = capabilities.supportsCharacterReference
    ? (job.characterReferences ?? []).filter(
        (reference) => reference.enabled !== false && reference.path,
      )
    : [];
  retainActiveKeys(
    run.cachedReferences,
    new Set(enabledReferences.map((reference) => reference.path)),
  );

  const references: CharacterReference[] = [];
  for (const reference of enabledReferences) {
    throwIfPreparationStopped(run, request?.signal);
    try {
      let image = run.cachedReferences.get(reference.path)?.image;
      if (!image) {
        const original = await loader.fetchReferenceImage(
          session,
          reference.path,
        );
        throwIfPreparationStopped(run, request?.signal);
        if (!original) continue;
        const raw = original.includes(',')
          ? dataUriToBase64(original)
          : original;
        image = await loader.reencodeReferenceForApi(raw);
        throwIfPreparationStopped(run, request?.signal);
        if (!image) continue;
      }
      const prepared: CharacterReference = {
        image,
        info: reference.info,
        strength: reference.strength ?? DEFAULT_REFERENCE_STRENGTH,
        fidelity: reference.fidelity ?? DEFAULT_REFERENCE_FIDELITY,
        referenceType: reference.referenceType || 'character',
        description: reference.referenceType || 'character',
      };
      run.cachedReferences.set(reference.path, prepared);
      references.push(prepared);
    } catch (error) {
      propagateUncertainRequest(error, run, request?.signal);
      console.warn(`Error preparing reference image ${reference.path}:`, error);
    }
  }

  // Precise Reference and Vibe Transfer cannot be combined. If a reference is
  // unreadable, preserve the previous behavior of falling back to usable vibes.
  const enabledVibes =
    capabilities.supportsVibeTransfer && references.length === 0
      ? job.vibes
      : [];
  const maxVibes = capabilities.maxVibeImages;
  if (maxVibes !== undefined && enabledVibes.length > maxVibes) {
    throw Object.assign(
      new Error(
        `NovelAI Vibe Transfer는 최대 ${maxVibes}개까지 사용할 수 있습니다.`,
      ),
      { retryable: false },
    );
  }
  retainActiveKeys(
    run.cachedVibes,
    new Set(enabledVibes.map((vibe) => `${vibe.path}:${vibe.info}`)),
  );

  const vibes: Vibe[] = [];
  for (const vibe of enabledVibes) {
    throwIfPreparationStopped(run, request?.signal);
    const key = `${vibe.path}:${vibe.info}`;
    try {
      let image = run.cachedVibes.get(key)?.image;
      if (!image) {
        const encoded = await loader.checkEncodedVibeImage(
          session,
          vibe.path,
          vibe.info,
        );
        throwIfPreparationStopped(run, request?.signal);
        if (!encoded) {
          await loader.encodeVibeImage(
            session,
            vibe.path,
            vibe.info,
            request,
            modelVersion,
            () => throwIfPreparationStopped(run, request?.signal),
          );
          // The dispatched encoder has finished saving its result; only the next step is cancelled.
          throwIfPreparationStopped(run, request?.signal);
        }
        image = dataUriToBase64(
          (await loader.fetchEncodedVibeImage(session, vibe.path, vibe.info)) ||
            '',
        );
        throwIfPreparationStopped(run, request?.signal);
        if (!image) {
          notify(
            `바이브 이미지를 불러올 수 없습니다 (${vibe.path}). 이미지를 다시 첨부해주세요.`,
          );
          continue;
        }
      }
      const prepared = { image, info: vibe.info, strength: vibe.strength };
      run.cachedVibes.set(key, prepared);
      vibes.push(prepared);
    } catch (error) {
      propagateUncertainRequest(error, run, request?.signal);
      console.warn(`Error preparing vibe image ${vibe.path}:`, error);
      notify(
        `바이브 이미지 처리 실패 (${vibe.path}). 이미지를 다시 첨부해주세요.`,
      );
    }
  }
  throwIfPreparationStopped(run, request?.signal);
  return { references, vibes };
}
