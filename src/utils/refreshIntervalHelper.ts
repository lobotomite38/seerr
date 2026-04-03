import type { DownloadingItem } from '@server/lib/downloadtracker';

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
