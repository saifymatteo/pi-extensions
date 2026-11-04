// Preload: replace pi-tui's macOS native clipboard addon so screenshots never
// touch the real clipboard. getImage serves FAKE_CLIP_PNG (if set).
const Module = require('module');
const fs = require('fs');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (String(request).endsWith('darwin-platform.node')) {
    return {
      getText: async () => '',
      setText: async () => {},
      getImage: async () => (process.env.FAKE_CLIP_PNG ? fs.readFileSync(process.env.FAKE_CLIP_PNG) : null),
      getFilePaths: async () => [],
    };
  }
  return load.call(this, request, ...rest);
};
