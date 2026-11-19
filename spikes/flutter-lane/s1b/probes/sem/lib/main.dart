// Step 7c: does Semantics(identifier:) reach the DOM as flt-semantics-identifier? (probe.mjs reads the DOM)
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'bridge.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SemanticsBinding.instance.ensureSemantics();
  runApp(MaterialApp(debugShowCheckedModeBanner: false, home: Scaffold(body: Center(child: Semantics(identifier: 'doop-probe-id', label: 'probe', button: true, child: const Text('probe'))))));
  Future.delayed(const Duration(seconds: 3), () => post('doop:flutter-probe', {'semanticsEnabled': SemanticsBinding.instance.semanticsEnabled}));
}
