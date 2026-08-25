interface RoleApiSource {
  db: { getSlide: unknown }
  fonts: { getEmbeddedFonts: unknown }
  presentation: {
    navigate: unknown
    exit: unknown
    onStateChanged: unknown
    signalReady: unknown
  }
  debug: {
    onStateUpdate: unknown
    requestState: unknown
    getLocale: unknown
    onLocaleChanged: unknown
  }
}

export function selectWindowRoleApi<T extends RoleApiSource>(
  api: T,
  windowRole: string | undefined
): object {
  if (windowRole === 'presentation') {
    return {
      db: { getSlide: api.db.getSlide },
      fonts: { getEmbeddedFonts: api.fonts.getEmbeddedFonts },
      presentation: {
        navigate: api.presentation.navigate,
        exit: api.presentation.exit,
        onStateChanged: api.presentation.onStateChanged,
        signalReady: api.presentation.signalReady
      }
    }
  }

  if (windowRole === 'debug') {
    return {
      debug: {
        onStateUpdate: api.debug.onStateUpdate,
        requestState: api.debug.requestState,
        getLocale: api.debug.getLocale,
        onLocaleChanged: api.debug.onLocaleChanged
      }
    }
  }

  return windowRole === 'editor' ? api : {}
}
