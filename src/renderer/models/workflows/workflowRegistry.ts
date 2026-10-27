import { WorkFlowService } from './WorkFlowService';

// Domain definitions have no backend, listeners, or application activation.
// The composition root populates this same registry at its explicit startup step.
export const workFlowService = new WorkFlowService();
