/** Build metadata is the single source for the fork's visible release channel. */
import metadata from '../../package.json';

export const APP_NAME = metadata.build.productName;
export const APP_ID = metadata.build.appId;
export const APP_DISPLAY_NAME = 'SDStudio · Cupcake 포크';
export const APP_REPOSITORY_URL = metadata.repository.url;
export const APP_RELEASES_URL = `${APP_REPOSITORY_URL}/releases`;
export const APP_RELEASE_CHANNEL = metadata.build.publish;
export const APP_UPDATE_CHANNEL = APP_RELEASE_CHANNEL.private
  ? 'private'
  : 'public';
export const APP_ANDROID_DATA_DIR = APP_RELEASE_CHANNEL.private
  ? '.SDStudio'
  : '.SDStudio-Cupcake-Public';
