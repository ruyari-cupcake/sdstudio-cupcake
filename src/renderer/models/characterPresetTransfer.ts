import type { CharacterPreset, ICharacterPreset, Session } from './types';

export type CharacterPresetTransferSession = Session;

interface ExportedPresetData {
  version: 1;
  presets: Array<
    ICharacterPreset & {
      vibeImages?: Array<{ filename: string; data: string }>;
      referenceImages?: Array<{ filename: string; data: string }>;
      representativeImageData?: string;
    }
  >;
}

/** File transfer is independent of the UI and the application service graph. */
export interface CharacterPresetTransferPorts {
  readDataFile(path: string): Promise<string>;
  writeDataFile(path: string, data: string): Promise<void>;
  existFile(path: string): Promise<boolean>;
  deleteFile(path: string): Promise<void>;
  getVibesDir(session: CharacterPresetTransferSession): string;
  getReferenceDir(session: CharacterPresetTransferSession): string;
  getVibeImagePath(
    session: CharacterPresetTransferSession,
    token: string,
  ): string;
  getReferenceImagePath(
    session: CharacterPresetTransferSession,
    token: string,
  ): string;
  newImageName(original: string): string;
  isSafeImageToken(token: unknown): boolean;
  presetFromJSON(value: ICharacterPreset): CharacterPreset;
  saveJsonFile(filename: string, data: string): Promise<unknown>;
  stringifyExportJson(value: unknown): string;
  pushMessage(message: string, type?: 'error'): void;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const imageBasename = (value: string) =>
  value.replace(/\\/g, '/').split('/').pop() || value;

export async function exportCharacterPresets(
  session: CharacterPresetTransferSession,
  ports: CharacterPresetTransferPorts,
): Promise<void> {
  const presets = session.getCharacterPresets();
  if (presets.length === 0) {
    ports.pushMessage('내보낼 캐릭터 프리셋이 없습니다');
    return;
  }
  try {
    const exported: ExportedPresetData = { version: 1, presets: [] };
    for (const preset of presets) {
      const json = preset.toJSON() as ExportedPresetData['presets'][number];
      json.vibeImages = [];
      for (const vibe of preset.vibes) {
        const data = await ports.readDataFile(
          ports.getVibeImagePath(session, vibe.path),
        );
        json.vibeImages.push({ filename: imageBasename(vibe.path), data });
      }
      json.referenceImages = [];
      for (const reference of preset.characterReferences) {
        const data = await ports.readDataFile(
          ports.getReferenceImagePath(session, reference.path),
        );
        json.referenceImages.push({
          filename: imageBasename(reference.path),
          data,
        });
      }
      if (preset.representativeImage) {
        json.representativeImageData = await ports.readDataFile(
          ports.getVibeImagePath(session, preset.representativeImage),
        );
      }
      exported.presets.push(json);
    }
    const result = await ports.saveJsonFile(
      `${session.name}_character_presets.json`,
      ports.stringifyExportJson(exported),
    );
    if (result !== 'cancelled') {
      ports.pushMessage(`${presets.length}개 캐릭터 프리셋을 내보냈습니다`);
    }
  } catch (error) {
    ports.pushMessage(
      `캐릭터 프리셋 내보내기 실패: ${errorText(error)}`,
      'error',
    );
  }
}

export async function importCharacterPresets(
  session: CharacterPresetTransferSession,
  file: Pick<File, 'text'>,
  ports: CharacterPresetTransferPorts,
): Promise<void> {
  let imported = 0;
  try {
    const data = JSON.parse(await file.text()) as ExportedPresetData;
    if (!data || !Array.isArray(data.presets)) {
      throw new Error('올바른 캐릭터 프리셋 파일이 아닙니다');
    }
    for (const presetJson of data.presets) {
      const createdPaths: string[] = [];
      const ownedPaths = new Set<string>();
      const renamedVibes = new Map<string, string>();
      const renamedReferences = new Map<string, string>();
      const payloads = new Map<string, string>();
      try {
        const storeImage = async (
          original: string,
          payload: string,
          kind: 'vibe' | 'reference',
        ): Promise<string> => {
          if (
            typeof original !== 'string' ||
            !original ||
            typeof payload !== 'string'
          ) {
            throw new Error('이미지 첨부 데이터가 올바르지 않습니다');
          }
          const map = kind === 'vibe' ? renamedVibes : renamedReferences;
          const basename = imageBasename(original);
          const existing = map.get(original) || map.get(basename);
          const payloadKey = `${kind}:${basename}`;
          if (existing) {
            if (payloads.get(payloadKey) !== payload) {
              throw new Error(
                `서로 다른 이미지에 같은 파일명이 지정되었습니다: ${basename}`,
              );
            }
            return existing;
          }
          const directory =
            kind === 'vibe'
              ? ports.getVibesDir(session)
              : ports.getReferenceDir(session);
          let token: string;
          let destination: string;
          do {
            token = ports.newImageName(original);
            if (!ports.isSafeImageToken(token))
              throw new Error('안전하지 않은 이미지 저장 이름입니다');
            destination = `${directory}/${token}`;
          } while (
            ownedPaths.has(destination) ||
            (await ports.existFile(destination))
          );
          // Own the fresh path before writing, so a partially written file is also cleaned up.
          createdPaths.push(destination);
          ownedPaths.add(destination);
          await ports.writeDataFile(destination, payload);
          map.set(original, token);
          map.set(basename, token);
          payloads.set(payloadKey, payload);
          return token;
        };
        if (Array.isArray(presetJson.vibeImages)) {
          for (const image of presetJson.vibeImages)
            await storeImage(image.filename, image.data, 'vibe');
        }
        if (Array.isArray(presetJson.referenceImages)) {
          for (const image of presetJson.referenceImages)
            await storeImage(image.filename, image.data, 'reference');
        }
        if (
          presetJson.representativeImageData &&
          presetJson.representativeImage
        ) {
          presetJson.representativeImage = await storeImage(
            presetJson.representativeImage,
            presetJson.representativeImageData,
            'vibe',
          );
        }
        const remap = (token: string, map: Map<string, string>) =>
          map.get(token) || map.get(imageBasename(token)) || token;
        presetJson.vibes = (presetJson.vibes || []).map((vibe) => ({
          ...vibe,
          path: remap(vibe.path, renamedVibes),
        }));
        presetJson.characterReferences = (
          presetJson.characterReferences || []
        ).map((reference) => ({
          ...reference,
          path: remap(reference.path, renamedReferences),
        }));
        if (presetJson.representativeImage) {
          presetJson.representativeImage = remap(
            presetJson.representativeImage,
            renamedVibes,
          );
        }
        delete presetJson.vibeImages;
        delete presetJson.referenceImages;
        delete presetJson.representativeImageData;
        const preset = ports.presetFromJSON(presetJson);
        while (session.hasCharacterPreset(preset.name)) preset.name += '_1';
        // Publish only after every attachment of this preset has been persisted.
        session.addCharacterPreset(preset);
        imported += 1;
      } catch (error) {
        let cleanupFailures = 0;
        for (const createdPath of createdPaths) {
          try {
            if (await ports.existFile(createdPath))
              await ports.deleteFile(createdPath);
          } catch {
            cleanupFailures += 1;
          }
        }
        if (cleanupFailures) {
          ports.pushMessage(
            `실패한 가져오기의 임시 이미지 ${cleanupFailures}개를 정리하지 못했습니다.`,
            'error',
          );
        }
        throw error;
      }
    }
    ports.pushMessage(`${imported}개 캐릭터 프리셋을 불러왔습니다`);
  } catch (error) {
    ports.pushMessage(
      `캐릭터 프리셋 불러오기 실패 (${imported}개 완료): ${errorText(error)}`,
      'error',
    );
  }
}
