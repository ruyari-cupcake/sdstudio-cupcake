import type { FileEntry } from '../backend';
import { AndroidBackend } from '../backends/androidBackend';
import { ElectornBackend } from '../backends/electronBackend';
import { workFlowService } from './workflows/workflowRegistry';
import type { OpusUsageService } from './OpusUsageService';
import type { SessionService } from './SessionService';
import type { ImageService } from './ImageService';
import type { TrashService } from './TrashService';
import type { ImageDownloadService } from './ImageDownloadService';
import type { ProjectSizeService } from './ProjectSizeService';
import type { TemplateService } from './TemplateService';
import type { ProjectTemplateService } from './ProjectTemplateService';
import type { ArtistTagService } from './ArtistTagService';
import type { GlobalPieceService } from './GlobalPieceService';
import type { GlobalPresetService } from './GlobalPresetService';
import type { GlobalCharacterPresetService } from './GlobalCharacterPresetService';
import type { ArtistLibraryService } from './ArtistLibraryService';
import type { BackupService } from './BackupService';
import type { BatchProcessService } from './BatchProcessService';
import type { ExportPresetService } from './ExportPresetService';
import type { PromptService } from './PromptService';
import type { TaskQueueService } from './TaskQueueService';
import type { LoginService } from './LoginService';
import type { GameService } from './GameService';
import type { ImageHistoryService } from './ImageHistoryService';
import type { AppUpdateNoticeService } from './AppUpdateNoticeService';
import type { LocalAIService } from './LocalAIService';
import type { CyclingSessionService } from './CyclingSessionService';
import type { BackgroundNotificationService } from './BackgroundNotificationService';
import type { BackgroundKeepAliveService } from './BackgroundKeepAliveService';

// Keep platform/backend primitives available while application service modules load.
// This public API has no runtime imports of those services, so peers can import it
// without recursively constructing the application graph.
export { workFlowService };

export const backend =
  window.electron != null ? new ElectornBackend() : new AndroidBackend();

export const isMobile = window.electron == null;

export class ZipService extends EventTarget {
  isZipping: boolean;

  constructor() {
    super();
    this.isZipping = false;
  }

  async zipFiles(files: FileEntry[], outPath: string) {
    this.isZipping = true;
    try {
      await backend.zipFiles(files, outPath);
    } finally {
      // 예외가 나도 잠금이 영구 고착되지 않도록 항상 해제
      this.isZipping = false;
    }
  }
}

export const zipService = new ZipService();

export let opusUsageService: OpusUsageService;
export let sessionService: SessionService;
export let imageService: ImageService;
export let trashService: TrashService;
export let imageDownloadService: ImageDownloadService;
export let projectSizeService: ProjectSizeService;
export let templateService: TemplateService;
export let projectTemplateService: ProjectTemplateService;
export let artistTagService: ArtistTagService;
export let globalPieceService: GlobalPieceService;
export let globalPresetService: GlobalPresetService;
export let globalCharacterPresetService: GlobalCharacterPresetService;
export let artistLibraryService: ArtistLibraryService;
export let backupService: BackupService;
export let batchProcessService: BatchProcessService;
export let exportPresetService: ExportPresetService;
export let promptService: PromptService;
export let taskQueueService: TaskQueueService;
export let loginService: LoginService;
export let gameService: GameService;
export let imageHistoryService: ImageHistoryService;
export let appUpdateNoticeService: AppUpdateNoticeService;
export let localAIService: LocalAIService;
export let cyclingSessionService: CyclingSessionService;
export let backgroundNotificationService: BackgroundNotificationService;
export let backgroundKeepAliveService: BackgroundKeepAliveService;

export interface ApplicationServices {
  readonly opusUsageService: OpusUsageService;
  readonly sessionService: SessionService;
  readonly imageService: ImageService;
  readonly trashService: TrashService;
  readonly imageDownloadService: ImageDownloadService;
  readonly projectSizeService: ProjectSizeService;
  readonly templateService: TemplateService;
  readonly projectTemplateService: ProjectTemplateService;
  readonly artistTagService: ArtistTagService;
  readonly globalPieceService: GlobalPieceService;
  readonly globalPresetService: GlobalPresetService;
  readonly globalCharacterPresetService: GlobalCharacterPresetService;
  readonly artistLibraryService: ArtistLibraryService;
  readonly backupService: BackupService;
  readonly batchProcessService: BatchProcessService;
  readonly exportPresetService: ExportPresetService;
  readonly promptService: PromptService;
  readonly taskQueueService: TaskQueueService;
  readonly loginService: LoginService;
  readonly gameService: GameService;
  readonly imageHistoryService: ImageHistoryService;
  readonly appUpdateNoticeService: AppUpdateNoticeService;
  readonly localAIService: LocalAIService;
  readonly cyclingSessionService: CyclingSessionService;
  readonly backgroundNotificationService: BackgroundNotificationService;
  readonly backgroundKeepAliveService: BackgroundKeepAliveService;
}

let servicesInstalled = false;

// ESM live bindings preserve the named-instance API. They are assigned exactly once
// by composeServices before workflow registration, bootstrap, or App evaluation.
export function installServices(services: ApplicationServices): void {
  if (servicesInstalled) {
    throw new Error('Application services are already installed.');
  }
  ({
    opusUsageService,
    sessionService,
    imageService,
    trashService,
    imageDownloadService,
    projectSizeService,
    templateService,
    projectTemplateService,
    artistTagService,
    globalPieceService,
    globalPresetService,
    globalCharacterPresetService,
    artistLibraryService,
    backupService,
    batchProcessService,
    exportPresetService,
    promptService,
    taskQueueService,
    loginService,
    gameService,
    imageHistoryService,
    appUpdateNoticeService,
    localAIService,
    cyclingSessionService,
    backgroundNotificationService,
    backgroundKeepAliveService,
  } = services);
  servicesInstalled = true;
}
