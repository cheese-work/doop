// Step 7b: FontLoader with font bytes fetched from a URL (stands in for SF Pro, which is never committed).
import 'dart:js_interop';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:web/web.dart' as web;
import 'bridge.dart';

double width(String family) {
  final p = TextPainter(text: TextSpan(text: 'Hamburgefonstiv 0123', style: TextStyle(fontFamily: family, fontSize: 40)), textDirection: TextDirection.ltr)..layout();
  return p.width;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final res = await web.window.fetch('/blob/DejaVuSerif.ttf'.toJS).toDart;
  final bytes = ByteData.view((await res.arrayBuffer().toDart).toDart);
  final before = width('Probe');
  final loader = FontLoader('Probe')..addFont(Future.value(bytes));
  await loader.load();
  final after = width('Probe');
  runApp(const MaterialApp(debugShowCheckedModeBanner: false, home: Scaffold(body: Center(child: Text('Hamburgefonstiv 0123', style: TextStyle(fontFamily: 'Probe', fontSize: 40))))));
  post('doop:flutter-probe', {'bytes': bytes.lengthInBytes, 'widthBefore': before, 'widthAfter': after, 'differs': before != after});
}
