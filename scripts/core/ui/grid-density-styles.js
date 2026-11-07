const DEFAULT_CARD_PAD_RANGE = [2, 6, 'px'];
const DEFAULT_TITLE_SIZE_RANGE = [0.68, 0.78, 'rem'];
const DEFAULT_DETAILS_SIZE_RANGE = [0.58, 0.68, 'rem'];
const DEFAULT_FOOTER_PADDING_TOP_RANGE = [0, 4, 'px'];

function setInterpolatedStyle(container, property, [min, max, unit], t) {
  container.style.setProperty(property, `${min + (max - min) * t}${unit}`);
}

export function applyGridDensityStyles(container, t, options = {}) {
  if (!container) return;
  const clamped = Math.max(0, Math.min(1, t));
  setInterpolatedStyle(container, '--fa-nexus-card-pad', options.cardPad || DEFAULT_CARD_PAD_RANGE, clamped);
  setInterpolatedStyle(container, '--fa-nexus-title-size', options.titleSize || DEFAULT_TITLE_SIZE_RANGE, clamped);
  setInterpolatedStyle(container, '--fa-nexus-details-size', options.detailsSize || DEFAULT_DETAILS_SIZE_RANGE, clamped);
  setInterpolatedStyle(container, '--fa-nexus-footer-pt', options.footerPaddingTop || DEFAULT_FOOTER_PADDING_TOP_RANGE, clamped);
}
