/* eslint-disable no-unused-expressions -- the two template lines below are Flutter build tokens, not JS */
// prettier-ignore
{{flutter_js}}
// prettier-ignore
{{flutter_build_config}}
// No service worker: navigator.serviceWorker throws inside a sandbox="allow-scripts" frame (opaque origin),
// which is what the stock bootstrap touches first. The frame has no use for an offline cache.
_flutter.loader.load()
