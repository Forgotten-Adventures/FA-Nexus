import { ToolOptionsController } from './tool-options/controller.js';
import { ToolOptionsWindow } from './tool-options/window.js';

/**
 * Central controller that coordinates the tool options window across placement
 * managers and premium editors.
 */
export const toolOptionsController = new ToolOptionsController({ ToolOptionsWindowClass: ToolOptionsWindow });
export { ToolOptionsController, ToolOptionsWindow };
