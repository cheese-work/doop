// Step 7a: does package:rive compile and draw under DartPad, with the .riv bytes loaded from a URL?
import 'dart:js_interop';
import 'package:flutter/material.dart';
import 'package:rive/rive.dart';
import 'package:web/web.dart' as web;
import 'bridge.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    final res = await web.window.fetch('/blob/rocket.riv'.toJS).toDart;
    final bytes = (await res.arrayBuffer().toDart).toDart.asUint8List();
    await RiveNative.init();
    final file = await File.decode(bytes, riveFactory: Factory.rive);
    final controller = RiveWidgetController(file!);
    runApp(MaterialApp(debugShowCheckedModeBanner: false, home: Scaffold(body: RiveWidget(controller: controller))));
    post('doop:flutter-probe', {'ok': true, 'bytes': bytes.length});
  } catch (e, st) {
    post('doop:flutter-probe', {'ok': false, 'error': '$e', 'stack': '$st'.split('\n').take(5).join(' | ')});
  }
}
