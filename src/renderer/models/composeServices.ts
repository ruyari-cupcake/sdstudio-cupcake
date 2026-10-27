import * as services from '.';
import { GameService } from './GameService';
import { ImageService, toggleImageMain } from './ImageService';
import { ImageDownloadService } from './ImageDownloadService';
import { LoginService } from './LoginService';
import { PromptService } from './PromptService';
import { SessionService } from './SessionService';
import { TaskQueueService } from './TaskQueueService';
import { taskHandlers } from './TaskHandlers';
import { LocalAIService } from './LocalAIService';
import { AppUpdateNoticeService } from './AppUpdateNoticeService';
import { registerWorkFlows } from './workflows';
import { TrashService } from './TrashService';
import { CyclingSessionService } from './CyclingSessionService';
import { GlobalPieceService } from './GlobalPieceService';
import { GlobalPresetService } from './GlobalPresetService';
import { GlobalCharacterPresetService } from './GlobalCharacterPresetService';
import { BackgroundNotificationService } from './BackgroundNotificationService';
import { BackgroundKeepAliveService } from './BackgroundKeepAliveService';
import { ProjectSizeService } from './ProjectSizeService';
import { TemplateService } from './TemplateService';
import { ProjectTemplateService } from './ProjectTemplateService';
import { ArtistTagService } from './ArtistTagService';
import { ArtistLibraryService } from './ArtistLibraryService';
import { BackupService } from './BackupService';
import { BatchProcessService } from './BatchProcessService';
import { ExportPresetService } from './ExportPresetService';
import { ImageHistoryService } from './ImageHistoryService';
import { OpusUsageService } from './OpusUsageService';

const { backend, workFlowService } = services;

const opusUsageService = new OpusUsageService(backend);

// Construct application services synchronously in one explicit composition entry.
// Asynchronous loading, scanning, and loops remain owned by bootstrapApp.
const sessionService = new SessionService(backend);

const imageService = new ImageService();

const trashService = new TrashService({
  backend,
  sessionService,
  imageService,
  // TemplateService is constructed below; resolve it only when trash operations use it.
  get templateService(): TemplateService {
    return services.templateService;
  },
});

const imageDownloadService = new ImageDownloadService();

// 프로젝트별 용량 수동 계산 (시작 시 로드 없음 — 설정 화면에서 지연 로드)
const projectSizeService = new ProjectSizeService(backend, sessionService);

// 프로젝트 템플릿 지정 (시작 시 로드 없음 — 생성/지정 시 지연 로드)
const templateService = new TemplateService({
  backend,
  sessionService,
  trashService,
  get projectTemplateService(): ProjectTemplateService {
    return services.projectTemplateService;
  },
  get globalPieceService(): GlobalPieceService {
    return services.globalPieceService;
  },
});

// 프로젝트 템플릿 엔티티 (프로젝트 상속 v2 — 시작 시 로드 없음, 지연 로드)
const projectTemplateService = new ProjectTemplateService({
  backend,
  imageService,
  workFlowService,
  sessionService,
  templateService,
  get globalPresetService(): GlobalPresetService {
    return services.globalPresetService;
  },
  get globalCharacterPresetService(): GlobalCharacterPresetService {
    return services.globalCharacterPresetService;
  },
});

// 아티스트 태깅 (데스크톱 전용, 시작 시 비용 없음 — 모달에서 지연 사용)
const artistTagService = new ArtistTagService(backend);

const globalPieceService = new GlobalPieceService(backend);

const globalPresetService = new GlobalPresetService(
  backend,
  imageService,
  workFlowService,
);

const globalCharacterPresetService = new GlobalCharacterPresetService(
  backend,
  imageService,
);

const artistLibraryService = new ArtistLibraryService(backend);

// 백업/내보내기/가져오기 (AppService 에서 분리). 생성자 비용 없음.
const backupService = new BackupService();

// 배치 처리/해상도 변경 (AppService 에서 분리). 생성자 비용 없음.
const batchProcessService = new BatchProcessService();

// 내보내기 프리셋/패키지 (AppService 에서 분리). 생성자 비용 없음.
const exportPresetService = new ExportPresetService();

const promptService = new PromptService();

const taskQueueService = new TaskQueueService(taskHandlers);

const loginService = new LoginService(backend);

const gameService = new GameService(backend, imageService);

// 최근 생성 이미지 히스토리 (history.json 영속, 전체 최근 30장 — 우측 사이드바)
const imageHistoryService = new ImageHistoryService(
  backend,
  imageService,
  sessionService,
  toggleImageMain,
);

const appUpdateNoticeService = new AppUpdateNoticeService(backend);

const localAIService = new LocalAIService(backend);

const cyclingSessionService = new CyclingSessionService();

// 모바일 백그라운드 포그라운드 서비스 알림에 생성 진행 상태를 표시
const backgroundNotificationService = new BackgroundNotificationService(
  taskQueueService,
  backend,
);

// 모바일 백그라운드 생성 중 Chromium 페이지 동결 우회 (무음 오디오 keep-alive)
const backgroundKeepAliveService = new BackgroundKeepAliveService(
  taskQueueService,
);

services.installServices({
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
});

registerWorkFlows(workFlowService);

window.promptService = promptService;
window.sessionService = sessionService;
window.imageService = imageService;
window.imageDownloadService = imageDownloadService;
window.taskQueueService = taskQueueService;
window.loginService = loginService;
window.globalPresetService = globalPresetService;
