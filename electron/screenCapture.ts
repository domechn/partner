export type ScreenCaptureThumbnail = {
  isEmpty: () => boolean;
  toDataURL: () => string;
};

export type ScreenCaptureSource = {
  id: string;
  name: string;
  display_id?: string;
  thumbnail: ScreenCaptureThumbnail;
};

export type ScreenCaptureSize = {
  width: number;
  height: number;
};

export type GetScreenCaptureSources = (options: {
  types: ["screen"];
  thumbnailSize: ScreenCaptureSize;
}) => Promise<ScreenCaptureSource[]>;

export type CaptureScreenImageOptions = {
  getSources: GetScreenCaptureSources;
  primaryDisplayId?: number;
  thumbnailSize?: ScreenCaptureSize;
};

const DEFAULT_SCREEN_THUMBNAIL_SIZE = {
  width: 1280,
  height: 720,
};

export async function captureScreenImageBase64(
  options: CaptureScreenImageOptions,
): Promise<string | undefined> {
  const sources = await options.getSources({
    types: ["screen"],
    thumbnailSize: options.thumbnailSize ?? DEFAULT_SCREEN_THUMBNAIL_SIZE,
  });
  const source = selectScreenCaptureSource(sources, options.primaryDisplayId);
  if (!source) {
    return undefined;
  }

  return stripImageDataUrl(source.thumbnail.toDataURL());
}

export function selectScreenCaptureSource(
  sources: ScreenCaptureSource[],
  primaryDisplayId?: number,
): ScreenCaptureSource | null {
  const nonEmptySources = sources.filter(
    (source) => !source.thumbnail.isEmpty(),
  );
  if (nonEmptySources.length === 0) {
    return null;
  }

  const primaryDisplayIdText = primaryDisplayId?.toString();
  if (primaryDisplayIdText) {
    const primarySource = nonEmptySources.find(
      (source) => source.display_id === primaryDisplayIdText,
    );
    if (primarySource) {
      return primarySource;
    }
  }

  return nonEmptySources[0] ?? null;
}

export function stripImageDataUrl(value: string): string {
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
}
