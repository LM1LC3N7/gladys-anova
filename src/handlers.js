// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS, SCENE_ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the devices of the Anova account.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // The only command feature: the stop button, never refused (src/app.js).
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Scene actions: the start needs its option, the stop none.
  gladys.onSceneAction(SCENE_ACTIONS.START_COOK, (fields) => app.startCook(fields));
  gladys.onSceneAction(SCENE_ACTIONS.STOP_COOK, (fields) => app.sceneStop(fields));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle: the configuration is read by the app (asked again
  // on a timer when Gladys cannot give it).
  gladys.on('connected', async () => {
    try {
      await app.connected();
    } catch (err) {
      logger?.error(`Start failed: ${err?.message ?? 'unknown error'}`);
    }
  });
}
