const DIRECT_R2_TOKEN_URL_PATTERN = /^https?:\/\/r2-public\.forgotten-adventures\.net\//i;
const DOWNLOADED_ICON_HTML = '<i class="fas fa-cloud-check"></i>';

export function isDirectTokenCacheUrl(localPath) {
  return DIRECT_R2_TOKEN_URL_PATTERN.test(String(localPath || ''));
}

export function applyTokenCardCachedState(card, localPath, {
  iconSelector = '.fa-nexus-status-icon',
  iconClassesToRemove = ['cloud-plus', 'cloud', 'premium'],
  setResolvedLocalPath = true,
  removeLocked = true,
  swallowErrors = true
} = {}) {
  if (!card || !localPath) return { applied: false, cached: false, directUrl: false };
  const directUrl = isDirectTokenCacheUrl(localPath);

  const apply = () => {
    card.setAttribute?.('data-url', localPath);
    if (setResolvedLocalPath) {
      card._resolvedLocalPath = localPath;
    }

    const icon = iconSelector ? card.querySelector?.(iconSelector) : null;
    if (directUrl) {
      card.removeAttribute?.('data-cached');
      if (icon) {
        icon.classList.remove('cached');
        if (icon.title === 'Downloaded') icon.title = '';
        if (icon.innerHTML === DOWNLOADED_ICON_HTML) icon.innerHTML = '';
      }
      return { applied: true, cached: false, directUrl };
    }

    card.setAttribute?.('data-cached', 'true');
    if (removeLocked) {
      card.classList?.remove?.('locked-token');
    }
    if (icon) {
      if (iconClassesToRemove?.length) icon.classList.remove(...iconClassesToRemove);
      icon.classList.add('cloud', 'cached');
      icon.title = 'Downloaded';
      icon.innerHTML = DOWNLOADED_ICON_HTML;
    }
    return { applied: true, cached: true, directUrl };
  };

  if (!swallowErrors) return apply();
  try {
    return apply();
  } catch (_) {
    return { applied: false, cached: false, directUrl };
  }
}
