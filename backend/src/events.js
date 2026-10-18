import { EventEmitter } from 'node:events';

export function createBuildEvents() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    publish(buildId, event) {
      emitter.emit(buildId, event);
    },
    subscribe(buildId, listener) {
      emitter.on(buildId, listener);
      return () => emitter.off(buildId, listener);
    }
  };
}
