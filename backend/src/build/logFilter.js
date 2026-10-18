const NOISE_START = 'Unable to receive command from client socket connection';
const CONTINUATION = /^(\s+at\s|\s+\.\.\.\s\d+\smore|Caused by:|org\.gradle\.[\w.]+Exception)/;

export const NOISE_NOTICE = 'Ignoring unexpected connections to a local Gradle port. They come from the hosting platform, not from the build.';

export function createLogFilter(emit) {
  let suppressing = false;
  let ignored = 0;
  return {
    push(line) {
      if (line.startsWith(NOISE_START)) {
        suppressing = true;
        ignored += 1;
        if (ignored === 1) emit(NOISE_NOTICE);
        return;
      }
      if (suppressing) {
        if (CONTINUATION.test(line)) return;
        suppressing = false;
      }
      emit(line);
    },
    ignoredCount() {
      return ignored;
    }
  };
}
