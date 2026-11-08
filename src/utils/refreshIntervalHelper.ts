import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { DownloadingItem } from '@server/lib/downloadtracker';

export const getRequestDownloadStatus = (
  downloadStatus: DownloadingItem[] | undefined,
  seasonNumbers: number[]
): DownloadingItem[] => {
  const items = downloadStatus ?? [];

  if (!seasonNumbers.length) {
    return items;
  }

  return items.filter(
    (item) => item.episode && seasonNumbers.includes(item.episode.seasonNumber)
  );
};

export const refreshIntervalHelper = (
  downloadItem: {
    downloadStatus: DownloadingItem[] | undefined;
    downloadStatus4k: DownloadingItem[] | undefined;
    downloadPending?: boolean;
    downloadPending4k?: boolean;
  },
  timer: number
) => {
  if (
    (downloadItem.downloadStatus ?? []).length > 0 ||
    (downloadItem.downloadStatus4k ?? []).length > 0 ||
    downloadItem.downloadPending ||
    downloadItem.downloadPending4k
  ) {
    return timer;
  } else {
    return 0;
  }
};

export const mediaRefreshInterval = (
  media: Media | undefined,
  sawDownload: { current: boolean },
  timer: number
) => {
  if (
    refreshIntervalHelper(
      {
        downloadStatus: media?.downloadStatus,
        downloadStatus4k: media?.downloadStatus4k,
        downloadPending: media?.downloadPending,
        downloadPending4k: media?.downloadPending4k,
      },
      timer
    )
  ) {
    sawDownload.current = true;
    return timer;
  }

  // The queue empties before the media turns available, and briefly on every sync reset
  const processing = [media, ...(media?.seasons ?? [])].some(
    (item) =>
      item?.status === MediaStatus.PROCESSING ||
      item?.status4k === MediaStatus.PROCESSING
  );

  return sawDownload.current && processing ? timer : 0;
};
