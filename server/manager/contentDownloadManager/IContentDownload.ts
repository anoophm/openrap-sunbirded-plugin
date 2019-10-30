export interface DownloadCompletionEventData {
  status: string,
  createdOn: number,
  updatedOn: 1572438975695,
  stats: Stats,
  files: Array<Files>,
  id: string
}

interface Stats {
  totalFiles: number,
  downloadedFiles: number,
  totalSize: number,
  downloadedSize: number
}
interface Files {
  id: string,
  file: string,
  source: string,
  path: string,
  size: string,
  downloaded: string
}