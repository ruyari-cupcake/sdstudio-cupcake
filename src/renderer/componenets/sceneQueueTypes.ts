import { type GenericScene } from '../models/types';

export interface SceneQueueProps {
  type: 'scene' | 'inpaint';
  isActive?: boolean;
  filterFunc?: (scene: GenericScene) => boolean;
  onClose?: (x: number) => void;
  showPannel?: boolean;
  className?: string;
}
