import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'package:web/web.dart' as web;

/// Post a message to the embedding window (the frame iframe's parent, or self when top-level).
void post(String type, [Map<String, Object?> extra = const {}]) {
  final msg = <String, Object?>{'type': type, 'ts': DateTime.now().millisecondsSinceEpoch, ...extra};
  web.window.parent?.postMessage(msg.jsify(), '*'.toJS);
}

/// What the embedding policy gave this page: origin, storage, isolation, secure context.
Map<String, Object?> env() {
  String storage() {
    try {
      web.window.localStorage.setItem('doop-probe', '1');
      return web.window.localStorage.getItem('doop-probe') == '1' ? 'ok' : 'empty';
    } catch (e) {
      return 'blocked';
    }
  }

  return {
    'origin': web.window.origin,
    'localStorage': storage(),
    'crossOriginIsolated': web.window.crossOriginIsolated,
    'secureContext': web.window.isSecureContext,
    'sharedArrayBuffer': globalContext.has('SharedArrayBuffer'),
    'dpr': web.window.devicePixelRatio,
  };
}
