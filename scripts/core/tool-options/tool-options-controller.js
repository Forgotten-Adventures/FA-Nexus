import { ToolOptionsController } from './controller.js';
import { ToolOptionsWindow } from './window.js';

/**
 * Central controller that coordinates the tool options window across placement
 * managers and premium editors.
 */
export const toolOptionsController = new ToolOptionsController({ ToolOptionsWindowClass: ToolOptionsWindow });
export { ToolOptionsController, ToolOptionsWindow };
