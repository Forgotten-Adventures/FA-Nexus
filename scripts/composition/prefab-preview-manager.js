import { HoverPreviewManager } from '../core/ui/hover-preview-manager.js';

export class PrefabPreviewManager extends HoverPreviewManager {
  _updateMeta(card,meta) {
    const width=Number(card?.dataset.gridW || this._activeCard?.dataset.gridW),height=Number(card?.dataset.gridH || this._activeCard?.dataset.gridH);
    if(this._dimsEl)this._dimsEl.textContent=width&&height ? `${+width.toFixed(1)} × ${+height.toFixed(1)} grid squares` : '';
  }
  _updateGridOverlay(card,attempt=0) {
    if(card?.dataset.gridW&&card?.dataset.gridH)return super._updateGridOverlay(card,attempt);
    const media=this._activeMediaEl||this._imgEl;
    if(media){media.style.backgroundImage='';media.style.boxShadow='';}
  }
  refreshGrid(card){if(this._activeCard===card){this._updateGridOverlay(card);this._updateMeta(card);}}
}
