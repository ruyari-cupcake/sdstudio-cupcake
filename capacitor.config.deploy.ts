import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ruyari.cupcake.sdstudio.public',
  appName: 'SDStudio Cupcake',
  webDir: 'release/app/dist/renderer',
  android: { allowMixedContent: true },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
