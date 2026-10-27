import type { Backend } from '../backend';
import { platform } from './platform';
import { getPlatform } from './util';

async function getLocalAIDownloadLink() {
  const platformName = await getPlatform();
  return `https://huggingface.co/mathneko/localai/resolve/main/LocalAI-${platformName}.zip?download=true`;
}
const QUALITY_DOWNLOAD_LINK =
  'https://github.com/sunho/BiRefNet/releases/download/sdstudio/quality';

export class LocalAIService extends EventTarget {
  downloading: boolean;

  modelLoaded: boolean;

  ready: boolean;

  constructor(
    private readonly backend: Pick<
      Backend,
      | 'deleteFile'
      | 'deleteDir'
      | 'download'
      | 'extractZip'
      | 'isLocalAIRunning'
      | 'spawnLocalAI'
      | 'existFile'
      | 'loadModel'
      | 'removeBackground'
    >,
  ) {
    super();
    this.downloading = false;
    this.modelLoaded = false;
    this.ready = false;
  }

  notifyDownloadProgress(percent: number) {
    this.dispatchEvent(new CustomEvent('progress', { detail: { percent } }));
  }

  modelChanged() {
    this.modelLoaded = false;
  }

  async download() {
    // 리눅스용 LocalAI 바이너리는 배포되지 않는다 — UI 에서도 막지만 이중 방어.
    if (!platform.supportsRemoveBg) {
      console.error('LocalAI is not supported on this platform.');
      return;
    }
    this.downloading = true;
    try {
      await this.backend.deleteFile('tmp/localai.zip');
    } catch {
      // A previous download may be absent; the new download owns write failures.
    }
    try {
      await this.backend.deleteDir('localai');
    } catch {
      // A previous runtime may be absent; extraction reports installation failures.
    }
    // The shared models directory also owns artist taggers. Download replaces only
    // LocalAI's named weights; preserve unrelated models and the previous weights
    // until the actual download writes its replacement.
    try {
      const ldl = await getLocalAIDownloadLink();
      this.dispatchEvent(new CustomEvent('stage', { detail: { stage: 0 } }));
      await this.backend.download(ldl, 'tmp', 'localai.zip');
      this.dispatchEvent(new CustomEvent('stage', { detail: { stage: 1 } }));
      await this.backend.download(QUALITY_DOWNLOAD_LINK, 'models', 'quality');
      this.dispatchEvent(new CustomEvent('stage', { detail: { stage: 2 } }));
      await this.backend.extractZip('tmp/localai.zip', '');
      await this.statsModels();
    } catch (e: any) {
      console.error(e);
    } finally {
      this.downloading = false;
    }
  }

  async spawnLocalAI() {
    const running = await this.backend.isLocalAIRunning();
    if (running) {
      return;
    }
    await this.backend.spawnLocalAI();
  }

  async statsModels() {
    const avail: any = {
      fast: false,
      quality: false,
    };
    let availExec = false;
    try {
      availExec = await this.backend.existFile('localai');
    } catch (e: any) {
      console.error(e);
    }
    for (const model of ['fast', 'quality']) {
      try {
        avail[model] = await this.backend.existFile(`models/${model}`);
      } catch (e: any) {
        console.error(e);
      }
    }
    if (availExec && avail.quality) {
      this.ready = true;
      this.spawnLocalAI();
    } else {
      this.ready = false;
    }
    this.dispatchEvent(new CustomEvent('updated', {}));
  }

  async loadModel() {
    const running = await this.backend.isLocalAIRunning();
    if (!this.ready || !running) throw new Error('Local AI not ready');
    const modelType = 'quality';
    this.modelLoaded = false;
    await this.backend.loadModel(`models/${modelType}`);
    this.modelLoaded = true;
  }

  async removeBg(image: string, outputFilePath: string) {
    if (!this.modelLoaded) await this.loadModel();
    await this.backend.removeBackground(image, outputFilePath);
  }
}
