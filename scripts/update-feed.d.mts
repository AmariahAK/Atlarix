export interface FeedFile {
  url: string;
  sha512: string;
  size: number;
}
export function feedFile(file: string): FeedFile;
export function feedYaml(opts: {
  version: string;
  files: FeedFile[];
  primary: FeedFile;
  releaseDate?: string;
}): string;
export function macFeed(
  version: string,
  files: FeedFile[],
  releaseDate?: string,
): string;
export function linuxFeed(
  version: string,
  files: FeedFile[],
  releaseDate?: string,
): string;
